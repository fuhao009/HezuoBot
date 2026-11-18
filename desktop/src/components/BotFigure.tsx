import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";

import {
  botShape,
  easePoseWeights,
  figureFrame,
  poseBlinks,
  poseRests,
  poseWeights,
  STILL,
  type BotShape,
  type FigureFrame,
  type PoseWeights,
} from "@/lib/bot-figure";
import type { BotShapeKind } from "../../../packages/shared/mascot-bodies";
import { botPose, type BotPose, type BotState } from "./bot-states";
import { mascotClock, usePrefersReducedMotion, type MascotTicket } from "./mascot-clock";
import { frameFloorMs, nextFrameAt } from "./mascot-motion";

const INK = "#0d1b26";
const BLINK_MS = 160;
const SPIN_MS = 700;
const COVER = { x: -30, y: -30, width: 160, height: 160 };
const SWEEP = { gradientUnits: "userSpaceOnUse", x1: 78, y1: 12, x2: 24, y2: 88 } as const;

let mounted = 0;

export interface BotFigureHandle {
  blink: () => void;
  spin: (durationMs?: number) => void;
}

export interface BotFigureProps {
  shape: BotShapeKind;
  /** Light, base and dark stops of the body. */
  gradient: readonly [string, string, string];
  state?: BotState;
  size?: number;
  gaze?: { x?: number; y?: number };
  eyeColor?: string;
  paused?: boolean;
  title?: string | null;
}

interface Live {
  shape: BotShape;
  pose: BotPose;
  gaze: { x: number; y: number };
  still: boolean;
  size: number;
}

interface Engine {
  live: Live;
  weights: PoseWeights;
  since: number;
  last: number;
  spin: number;
  offset: number;
  blinkUntil: number;
  spinStart: number | null;
  spinMs: number;
  ticket: MascotTicket | null;
}

export const BotFigure = forwardRef<BotFigureHandle, BotFigureProps>(function BotFigure(
  { shape: kind, gradient, state = "idle", size = 44, gaze, eyeColor = INK, paused = false, title = null },
  ref,
) {
  const uid = useId();
  const reduced = usePrefersReducedMotion();
  const live: Live = {
    shape: botShape(kind),
    pose: botPose(state),
    gaze: { x: gaze?.x ?? 0, y: gaze?.y ?? 0 },
    still: paused || reduced,
    size,
  };

  const outline = useRef<SVGPathElement>(null);
  const alarm = useRef<SVGRectElement>(null);
  const shadow = useRef<SVGEllipseElement>(null);
  const body = useRef<SVGGElement>(null);
  const face = useRef<SVGGElement>(null);
  const eyes = useRef<SVGGElement>(null);
  const happy = useRef<SVGPathElement>(null);
  const hurt = useRef<SVGPathElement>(null);
  const svg = useRef<SVGSVGElement>(null);

  const engine = useRef<Engine | null>(null);
  engine.current ??= {
    live,
    weights: poseWeights(live.pose),
    since: 0,
    last: 0,
    spin: 0,
    offset: mounted++ * 1.7,
    blinkUntil: 0,
    spinStart: null,
    spinMs: SPIN_MS,
    ticket: null,
  };
  const firstFrame = useRef<FigureFrame | null>(null);
  firstFrame.current ??= figureFrame(live.shape, poseWeights("idle"), STILL);
  const first = firstFrame.current;

  const paint = (frame: FigureFrame) => {
    outline.current?.setAttribute("d", frame.outline);
    alarm.current?.setAttribute("opacity", frame.alarm);
    shadow.current?.setAttribute("transform", frame.shadow);
    shadow.current?.setAttribute("opacity", frame.shadowOpacity);
    body.current?.setAttribute("transform", frame.body);
    face.current?.setAttribute("transform", frame.face);
    eyes.current?.setAttribute("transform", frame.eyes);
    eyes.current?.setAttribute("opacity", frame.eyesOpacity);
    happy.current?.setAttribute("opacity", frame.happy);
    hurt.current?.setAttribute("opacity", frame.hurt);
  };
  const wake = () => engine.current?.ticket?.wake(nextFrameAt(performance.now(), frameFloorMs(size)));

  useImperativeHandle(ref, () => ({
    blink: () => {
      if (!engine.current) return;
      engine.current.blinkUntil = performance.now() + BLINK_MS;
      wake();
    },
    spin: (durationMs = SPIN_MS) => {
      if (!engine.current) return;
      engine.current.spinStart = performance.now();
      engine.current.spinMs = durationMs;
      wake();
    },
  }));

  useLayoutEffect(() => {
    const e = engine.current;
    if (!e) return;
    if (e.live.pose !== live.pose) e.since = performance.now();
    e.live = live;
    if (live.still) {
      e.weights = poseWeights(live.pose);
      paint(figureFrame(live.shape, e.weights, { ...STILL, gaze: live.gaze }));
    } else {
      wake();
    }
  });

  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    const frame = (now: number) => {
      const current = e.live;
      if (current.still) return Infinity;
      const dt = Math.min(0.05, Math.max(0, (now - e.last) / 1000));
      e.last = now;
      const moving = easePoseWeights(e.weights, current.pose, dt);
      const tau = (now - e.since) / 1000;
      let turn = 0;
      if (e.spinStart !== null) {
        const progress = (now - e.spinStart) / e.spinMs;
        if (progress >= 1) e.spinStart = null;
        else turn = 360 * progress;
      }
      const t = now / 1000;
      const next = figureFrame(current.shape, e.weights, {
        t,
        tau,
        offset: e.offset,
        spin: e.spin,
        gaze: current.gaze,
        blinking: now < e.blinkUntil || poseBlinks(current.pose, { t, offset: e.offset }),
        turn,
      });
      e.spin += dt * next.work;
      paint(next);
      const resting = !moving && poseRests(current.pose, tau) && e.spinStart === null && now >= e.blinkUntil;
      return resting ? Infinity : nextFrameAt(now, frameFloorMs(current.size));
    };
    e.last = performance.now();
    const ticket = mascotClock().add(frame, svg.current);
    e.ticket = ticket;
    return () => {
      ticket.remove();
      e.ticket = null;
    };
  }, []);

  const [light, base, dark] = gradient;
  const shape = live.shape;
  return (
    <svg
      ref={svg}
      viewBox="0 0 100 100"
      width={`${size}px`}
      height={`${size}px`}
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      style={{ display: "block", flex: "none", overflow: "visible" }}
    >
      <defs>
        <clipPath id={`${uid}c`}>
          <path ref={outline} d={first.outline} />
        </clipPath>
        <linearGradient id={`${uid}g`} {...SWEEP}>
          <stop offset="0" style={{ stopColor: light }} />
          <stop offset=".45" style={{ stopColor: base }} />
          <stop offset="1" style={{ stopColor: dark }} />
        </linearGradient>
        <linearGradient id={`${uid}r`} {...SWEEP}>
          <stop offset="0" stopColor="#ffd0c6" />
          <stop offset=".45" stopColor="#ff8177" />
          <stop offset="1" stopColor="#dc4352" />
        </linearGradient>
        <radialGradient id={`${uid}h`} gradientUnits="userSpaceOnUse" cx="38" cy="28" r="44">
          <stop offset="0" stopColor="#fff" stopOpacity=".55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${uid}s`} gradientUnits="userSpaceOnUse" cx="48" cy="40" r="54">
          <stop offset=".6" stopColor={INK} stopOpacity="0" />
          <stop offset="1" stopColor={INK} stopOpacity=".42" />
        </radialGradient>
        <radialGradient id={`${uid}k`}>
          <stop offset="0" stopColor="#fff" stopOpacity=".85" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${uid}f`}>
          <stop offset="0" stopColor="#000" stopOpacity=".28" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse
        ref={shadow}
        cx="50"
        cy={shape.ground + 6}
        rx={shape.width * 0.36}
        ry="4.5"
        fill={`url(#${uid}f)`}
        transform={first.shadow}
        opacity={first.shadowOpacity}
      />
      <g ref={body} transform={first.body}>
        <g clipPath={`url(#${uid}c)`}>
          <rect {...COVER} fill={`url(#${uid}g)`} />
          <rect ref={alarm} {...COVER} fill={`url(#${uid}r)`} opacity={first.alarm} />
          <rect {...COVER} fill={`url(#${uid}s)`} />
          <rect {...COVER} fill={`url(#${uid}h)`} />
          <ellipse cx="37" cy="27" rx="11" ry="6.5" fill={`url(#${uid}k)`} transform="rotate(-28 37 27)" />
        </g>
        <g ref={face} transform={first.face}>
          <g ref={eyes} fill={eyeColor} transform={first.eyes} opacity={first.eyesOpacity}>
            <ellipse cx="-10.5" rx="4.7" ry="6.9" />
            <ellipse cx="10.5" rx="4.7" ry="6.9" />
            <circle cx="-12" cy="-2.9" r="1.8" fill="#fff" />
            <circle cx="9" cy="-2.9" r="1.8" fill="#fff" />
          </g>
          <path
            ref={happy}
            d="M-15.5 2.5q5-8.5 10 0M5.5 2.5q5-8.5 10 0"
            fill="none"
            stroke={eyeColor}
            strokeWidth="3.2"
            strokeLinecap="round"
            opacity={first.happy}
          />
          <path
            ref={hurt}
            d="M-14.5-4.5l7 4.5-7 4.5M14.5-4.5l-7 4.5 7 4.5"
            fill="none"
            stroke={eyeColor}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={first.hurt}
          />
        </g>
      </g>
    </svg>
  );
});
