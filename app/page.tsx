"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Pt = { id: number; x: number; y: number };

const TOTAL_POINTS = 10;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const snap = (v: number, step = 1) => Math.round(v / step) * step;

function toSvgCoords(vx: number, vy: number, w: number, h: number) {
  const x = ((vx + 10) / 20) * w;
  const y = ((10 - vy) / 20) * h;
  return { x, y };
}

function fromSvgCoords(px: number, py: number, w: number, h: number) {
  const vx = (px / w) * 20 - 10;
  const vy = 10 - (py / h) * 20;
  return { vx, vy };
}

// map -10..10 => 0..1
function axisToUnit(v: number) {
  return clamp((v + 10) / 20, 0, 1);
}

function makeImpulseResponse(ctx: AudioContext, seconds = 2.2, decay = 2.2) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const impulse = ctx.createBuffer(2, length, rate);

  for (let ch = 0; ch < impulse.numberOfChannels; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return impulse;
}

type Voice = {
  id: number;
  name: string;

  buffer: AudioBuffer | null;
  src: AudioBufferSourceNode | null;

  // routing
  gain: GainNode | null;

  delay: DelayNode | null;
  fb: GainNode | null;
  delayWet: GainNode | null;

  conv: ConvolverNode | null;
  reverbWet: GainNode | null;

  // state
  isPlaying: boolean;
  fileLabel: string;
};

function makeInitialPoints(): Pt[] {
  // nice spread for 10 points
  return [
    { id: 1, x: -8, y: 8 },
    { id: 2, x: -4, y: 8 },
    { id: 3, x: 0, y: 8 },
    { id: 4, x: 4, y: 8 },
    { id: 5, x: 8, y: 8 },

    { id: 6, x: -8, y: -2 },
    { id: 7, x: -4, y: -2 },
    { id: 8, x: 0, y: -2 },
    { id: 9, x: 4, y: -2 },
    { id: 10, x: 8, y: -2 },
  ];
}

export default function Home() {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);

  // Shared transport “time 0” anchor for phase sync
  const transportStartRef = useRef<number | null>(null);

  const [activeId, setActiveId] = useState<number | null>(null);
  const [padPx, setPadPx] = useState(360);
  const [audioOn, setAudioOn] = useState(false);

  const [bpm, setBpm] = useState(120);
  const [lastTapAt, setLastTapAt] = useState<number | null>(null);

  const [points, setPoints] = useState<Pt[]>(() => makeInitialPoints());

  // voices live in a ref so WebAudio nodes persist without re-renders
  const voicesRef = useRef<Record<number, Voice>>({});

  // cheap way to re-render readouts for file labels / isPlaying stored in ref
  const [, setUiTick] = useState(0);

  // ----- layout sizing -----
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPadPx(clamp(Math.floor(el.clientWidth), 260, 520)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = padPx;
  const h = padPx;

  const gridLines = useMemo(() => {
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number; kind: "minor" | "mid" | "axis" }> = [];
    for (let v = -10; v <= 10; v += 1) {
      const isAxis = v === 0;
      const isMid = !isAxis && v % 5 === 0;
      const kind: "minor" | "mid" | "axis" = isAxis ? "axis" : isMid ? "mid" : "minor";
      const px = ((v + 10) / 20) * w;
      lines.push({ x1: px, y1: 0, x2: px, y2: h, kind });
      const py = ((10 - v) / 20) * h;
      lines.push({ x1: 0, y1: py, x2: w, y2: py, kind });
    }
    return lines;
  }, [w, h]);

  function ensureAudio() {
    if (!audioRef.current) {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioRef.current = ctx;

      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      masterRef.current = master;

      // Set global “time 0” anchor ONCE.
      // Everything is phase-synced relative to this.
      transportStartRef.current = ctx.currentTime;
    }

    audioRef.current.resume?.();
    setAudioOn(true);

    // init voices if not present
    for (let id = 1; id <= TOTAL_POINTS; id++) {
      if (!voicesRef.current[id]) {
        voicesRef.current[id] = {
          id,
          name: `Sample ${id}`,
          buffer: null,
          src: null,
          gain: null,
          delay: null,
          fb: null,
          delayWet: null,
          conv: null,
          reverbWet: null,
          isPlaying: false,
          fileLabel: "No file loaded",
        };
      }
    }
  }

  function buildVoiceGraph(id: number) {
    const ctx = audioRef.current!;
    const master = masterRef.current!;
    const v = voicesRef.current[id];

    if (!v.gain) {
      const gain = ctx.createGain();
      gain.gain.value = 1.0;

      // Delay (simple feedback)
      const delay = ctx.createDelay(1.5);
      const fb = ctx.createGain();
      const delayWet = ctx.createGain();

      delayWet.gain.value = 0.0;
      fb.gain.value = 0.35;
      delay.delayTime.value = 0.25;

      // feedback loop
      delay.connect(fb);
      fb.connect(delay);

      // Reverb (convolver with generated impulse)
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulseResponse(ctx, 2.3, 2.2);
      const reverbWet = ctx.createGain();
      reverbWet.gain.value = 0.0;

      // dry
      gain.connect(master);

      // delay send/return
      gain.connect(delay);
      delay.connect(delayWet);
      delayWet.connect(master);

      // reverb send/return
      gain.connect(conv);
      conv.connect(reverbWet);
      reverbWet.connect(master);

      v.gain = gain;
      v.delay = delay;
      v.fb = fb;
      v.delayWet = delayWet;
      v.conv = conv;
      v.reverbWet = reverbWet;
    }
  }

  function applyXYToVoice(id: number, x: number, y: number) {
    const ctx = audioRef.current;
    if (!ctx) return;
    const v = voicesRef.current[id];
    if (!v.delay || !v.fb || !v.delayWet || !v.reverbWet) return;

    const delayAmt = axisToUnit(x); // 0..1
    const revAmt = axisToUnit(y); // 0..1

    // Delay: time 0..600ms, feedback 0.15..0.75, wet 0..0.9
    const delayTime = 0.0 + delayAmt * 0.6;
    const feedback = 0.15 + delayAmt * 0.6;
    const wet = delayAmt * 0.9;

    v.delay.delayTime.setTargetAtTime(delayTime, ctx.currentTime, 0.03);
    v.fb.gain.setTargetAtTime(feedback, ctx.currentTime, 0.03);
    v.delayWet.gain.setTargetAtTime(wet, ctx.currentTime, 0.03);

    // Reverb: wet 0..0.9
    v.reverbWet.gain.setTargetAtTime(revAmt * 0.9, ctx.currentTime, 0.03);
  }

  // keep effects synced to XY positions
  useEffect(() => {
    if (!audioOn) return;
    for (const p of points) applyXYToVoice(p.id, p.x, p.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioOn, points]);

  // ----- pointer interactions -----
  function setPointFromClient(clientX: number, clientY: number, id: number) {
    const svg = svgRef.current;
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const px = clamp(clientX - rect.left, 0, rect.width);
    const py = clamp(clientY - rect.top, 0, rect.height);

    const { vx, vy } = fromSvgCoords(px, py, rect.width, rect.height);
    const x = clamp(snap(vx, 1), -10, 10);
    const y = clamp(snap(vy, 1), -10, 10);

    setPoints((prev) => prev.map((p) => (p.id === id ? { ...p, x, y } : p)));
  }

  function nearestPointId(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return null;

    const rect = svg.getBoundingClientRect();
    const px = clamp(clientX - rect.left, 0, rect.width);
    const py = clamp(clientY - rect.top, 0, rect.height);

    let bestId: number | null = null;
    let bestD2 = Infinity;

    for (const p of points) {
      const pt = toSvgCoords(p.x, p.y, rect.width, rect.height);
      const dx = pt.x - px;
      const dy = pt.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestId = p.id;
      }
    }
    return bestId;
  }

  function onPadPointerDown(e: React.PointerEvent) {
    ensureAudio();
    e.preventDefault();

    const id = nearestPointId(e.clientX, e.clientY);
    if (id === null) return;

    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setActiveId(id);
    setPointFromClient(e.clientX, e.clientY, id);
  }

  function onPadPointerMove(e: React.PointerEvent) {
    if (activeId === null) return;
    e.preventDefault();
    setPointFromClient(e.clientX, e.clientY, activeId);
  }

  function onPadPointerUp(e?: React.PointerEvent) {
    if (e) e.preventDefault();
    setActiveId(null);
  }

  // ----- BPM helpers / tap tempo -----
  function secondsPerBeat() {
    return 60 / clamp(bpm, 30, 300);
  }

  // quantize to next bar
  function quantizeTimeToNextBar(now: number) {
    const t0 = transportStartRef.current ?? now;
    const spb = secondsPerBeat();
    const beatsPerBar = 4;

    const beatsSince = Math.max(0, (now - t0) / spb);
    const nextBarBeat = Math.ceil(beatsSince / beatsPerBar) * beatsPerBar;
    return t0 + nextBarBeat * spb;
  }

  function tapTempo() {
    ensureAudio();
    const now = performance.now();
    if (lastTapAt === null) {
      setLastTapAt(now);
      return;
    }
    const dtMs = now - lastTapAt;
    setLastTapAt(now);
    if (dtMs < 120 || dtMs > 2000) return;

    const next = Math.round(60_000 / dtMs);
    setBpm(clamp(next, 60, 200));
  }

  // ----- GLOBAL PHASE SYNC -----
  function loopOffsetAt(when: number, buf: AudioBuffer) {
    const t0 = transportStartRef.current ?? when;
    const dur = Math.max(0.0001, buf.duration);
    const rel = Math.max(0, when - t0);
    return rel % dur;
  }

  // ----- loading audio files -----
  async function loadFileForPoint(id: number, file: File) {
    ensureAudio();
    const ctx = audioRef.current!;
    buildVoiceGraph(id);

    const ab = await file.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);

    const v = voicesRef.current[id];
    v.buffer = buf;
    v.fileLabel = file.name;

    // If currently playing, restart phase-synced
    if (v.isPlaying) {
      stopPoint(id, true);
      startPoint(id, true);
    } else {
      setUiTick((n) => n + 1);
    }
  }

  // ----- start/stop loops -----
  function startPoint(id: number, quantized = true) {
    ensureAudio();
    const ctx = audioRef.current!;
    buildVoiceGraph(id);

    const v = voicesRef.current[id];
    if (!v.buffer || !v.gain) return;

    // stop any existing source
    if (v.src) {
      try {
        v.src.stop();
      } catch {}
      try {
        v.src.disconnect();
      } catch {}
      v.src = null;
    }

    const src = ctx.createBufferSource();
    src.buffer = v.buffer;
    src.loop = true;
    src.connect(v.gain);

    // apply current XY to this voice
    const p = points.find((pp) => pp.id === id);
    if (p) applyXYToVoice(id, p.x, p.y);

    const when = quantized ? quantizeTimeToNextBar(ctx.currentTime) : ctx.currentTime;
    const offset = loopOffsetAt(when, v.buffer);

    src.start(when, offset);

    v.src = src;
    v.isPlaying = true;

    setUiTick((n) => n + 1);
  }

  function stopPoint(id: number, immediate = false) {
    const ctx = audioRef.current;
    const v = voicesRef.current[id];
    if (!ctx || !v?.src) return;

    const stopAt = immediate ? ctx.currentTime : quantizeTimeToNextBar(ctx.currentTime);

    try {
      v.src.stop(stopAt);
    } catch {}

    window.setTimeout(() => {
      const vv = voicesRef.current[id];
      if (vv?.src) {
        try {
          vv.src.disconnect();
        } catch {}
        vv.src = null;
      }
      vv.isPlaying = false;
      setUiTick((n) => n + 1);
    }, Math.max(0, (stopAt - ctx.currentTime) * 1000) + 30);
  }

  function togglePoint(id: number) {
    const v = voicesRef.current[id];
    if (!v) return;
    if (!v.isPlaying) startPoint(id, true);
    else stopPoint(id, false);
  }

  const roleLabel = (id: number) => String(id);
  const delayLabel = (x: number) => `${Math.round(axisToUnit(x) * 100)}%`;
  const reverbLabel = (y: number) => `${Math.round(axisToUnit(y) * 100)}%`;

  useEffect(() => {
    return () => {
      const ctx = audioRef.current;
      try {
        for (let id = 1; id <= TOTAL_POINTS; id++) {
          const v = voicesRef.current[id];
          if (v?.src) {
            try {
              v.src.stop();
            } catch {}
          }
        }
      } catch {}
      ctx?.close?.();
      audioRef.current = null;
      masterRef.current = null;
      transportStartRef.current = null;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex min-h-screen w-full max-w-5xl flex-col items-center justify-center gap-8 py-14 px-6 bg-white dark:bg-black">
        <div ref={wrapperRef} className="w-full">
          <div className="mx-auto w-full max-w-[760px]">
            <div className="flex items-end justify-between gap-3">
              <h1 className="text-xl font-semibold tracking-tight text-black dark:text-zinc-50">Kaoss Pad Loops</h1>
              <div className="text-sm text-zinc-600 dark:text-zinc-400">
                {TOTAL_POINTS} points • X: <span className="font-medium">Delay</span> • Y:{" "}
                <span className="font-medium">Reverb</span>
              </div>
            </div>

            <div className="mt-3 rounded-2xl border border-black/10 bg-zinc-50 p-3 shadow-sm dark:border-white/15 dark:bg-zinc-950">
              {/* Transport */}
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={ensureAudio}
                    className="rounded-lg border border-black/10 bg-white px-3 py-1.5 text-sm font-medium text-black shadow-sm hover:bg-zinc-100 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
                  >
                    {audioOn ? "Audio On" : "Unlock Audio"}
                  </button>

                  <button
                    onClick={tapTempo}
                    className="rounded-lg border border-black/10 bg-white px-3 py-1.5 text-sm font-medium text-black shadow-sm hover:bg-zinc-100 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
                    title="Tap to set BPM"
                  >
                    Tap BPM
                  </button>
                </div>

                <div className="flex items-center gap-2 rounded-lg border border-black/10 bg-white px-3 py-1.5 dark:border-white/15 dark:bg-zinc-900">
                  <div className="text-xs text-zinc-600 dark:text-zinc-400">BPM</div>
                  <input
                    type="range"
                    min={60}
                    max={200}
                    step={1}
                    value={bpm}
                    onChange={(e) => setBpm(parseInt(e.target.value, 10))}
                    className="w-40"
                  />
                  <div className="w-12 text-right font-mono text-xs text-zinc-700 dark:text-zinc-300">{bpm}</div>
                </div>
              </div>

              {/* XY Pad */}
              <svg
                ref={svgRef}
                width={padPx}
                height={padPx}
                viewBox={`0 0 ${w} ${h}`}
                className={[
                  "mx-auto block select-none rounded-xl bg-white dark:bg-black",
                  "touch-none",
                  activeId !== null ? "cursor-grabbing" : "cursor-pointer",
                ].join(" ")}
                onPointerDown={onPadPointerDown}
                onPointerMove={onPadPointerMove}
                onPointerUp={onPadPointerUp}
                onPointerCancel={onPadPointerUp}
                onPointerLeave={onPadPointerUp}
                role="application"
                aria-label="XY pad"
              >
                <rect x={0} y={0} width={w} height={h} fill="transparent" />

                {gridLines.map((ln, i) => {
                  const cls =
                    ln.kind === "axis"
                      ? "stroke-black/35 dark:stroke-white/35"
                      : ln.kind === "mid"
                      ? "stroke-black/18 dark:stroke-white/18"
                      : "stroke-black/10 dark:stroke-white/10";
                  const sw = ln.kind === "axis" ? 2 : ln.kind === "mid" ? 1.5 : 1;
                  return (
                    <line
                      key={i}
                      x1={ln.x1}
                      y1={ln.y1}
                      x2={ln.x2}
                      y2={ln.y2}
                      className={cls}
                      strokeWidth={sw}
                      shapeRendering="crispEdges"
                    />
                  );
                })}

                <rect
                  x={0.5}
                  y={0.5}
                  width={w - 1}
                  height={h - 1}
                  rx={14}
                  ry={14}
                  fill="transparent"
                  className="stroke-black/20 dark:stroke-white/20"
                />

                {points.map((p) => {
                  const { x, y } = toSvgCoords(p.x, p.y, w, h);
                  const active = activeId === p.id;
                  const DOT_R = active ? 10 : 9;

                  return (
                    <g key={p.id} pointerEvents="none">
                      <circle
                        cx={x}
                        cy={y}
                        r={26}
                        fill="transparent"
                        className={active ? "stroke-black/25 dark:stroke-white/25" : "stroke-black/12 dark:stroke-white/12"}
                        strokeWidth={2}
                      />
                      <circle
                        cx={x}
                        cy={y}
                        r={DOT_R}
                        className={active ? "fill-black dark:fill-white" : "fill-black/80 dark:fill-white/80"}
                      />
                      <text x={x} y={y - 18} textAnchor="middle" className="select-none fill-zinc-700 text-[12px] dark:fill-zinc-300">
                        {roleLabel(p.id)}
                      </text>
                    </g>
                  );
                })}
              </svg>

              {/* Per-point controls */}
              <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
                {Array.from({ length: TOTAL_POINTS }, (_, i) => i + 1).map((id) => {
                  const p = points.find((pp) => pp.id === id)!;
                  const v = voicesRef.current[id];
                  const isPlaying = v?.isPlaying ?? false;
                  const fileLabel = v?.fileLabel ?? "No file loaded";

                  return (
                    <div
                      key={id}
                      className="rounded-xl border border-black/10 bg-white p-3 text-sm dark:border-white/15 dark:bg-zinc-900"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-baseline gap-3">
                          <div className="font-semibold text-black dark:text-zinc-50">Point {id}</div>
                          <div className="text-xs text-zinc-600 dark:text-zinc-400">{fileLabel}</div>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => togglePoint(id)}
                            className="rounded-lg border border-black/10 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-black shadow-sm hover:bg-zinc-100 dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-800"
                            disabled={!audioOn}
                            title={audioOn ? "Starts/stops on the next bar (phase-synced)" : "Unlock audio first"}
                          >
                            {isPlaying ? "Stop" : "Play"}
                          </button>

                          <button
                            onClick={() => stopPoint(id, true)}
                            className="rounded-lg border border-black/10 bg-white px-3 py-1.5 text-sm font-medium text-black shadow-sm hover:bg-zinc-100 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
                            disabled={!audioOn || !isPlaying}
                            title="Immediate stop"
                          >
                            Kill
                          </button>
                        </div>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                        <label className="flex items-center gap-2">
                          <span className="text-xs text-zinc-600 dark:text-zinc-400">Load loop</span>
                          <input
                            type="file"
                            accept="audio/*"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (!f) return;
                              loadFileForPoint(id, f);
                              e.currentTarget.value = "";
                            }}
                            className="text-xs"
                          />
                        </label>

                        <div className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                          x {p.x.toFixed(0)} → delay {delayLabel(p.x)}{" "}
                          <span className="text-zinc-400 dark:text-zinc-500">/</span>{" "}
                          y {p.y.toFixed(0)} → reverb {reverbLabel(p.y)}
                        </div>
                      </div>

                      <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                        Drag Point {id}: <span className="font-medium">X = delay</span>,{" "}
                        <span className="font-medium">Y = reverb</span>. Starts are{" "}
                        <span className="font-medium">phase-synced</span> to shared transport time 0.
                      </p>
                    </div>
                  );
                })}
              </div>

              <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
                All {TOTAL_POINTS} loops are phase-locked. If you start one later, it joins at the correct loop offset
                so everything stays aligned.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}