import { BOT_POSES, type BotPose } from "@/components/bot-states";
import type { BotShapeKind } from "../../shared/mascot-bodies";

const TAU = Math.PI * 2;
const UP = -Math.PI / 2;
const SAMPLES = 120;
const SIZE = 68;

type Radius = (angle: number) => number;
type Rand = (lo: number, hi: number) => number;
type Choose = <T>(list: readonly T[]) => T;

const mod = (x: number, m: number) => ((x % m) + m) % m;
const lobe = (x: number, k: number) => Math.sign(x) * Math.pow(Math.abs(x), k);

const polygon = (n: number, rot: number, sharp: number): Radius => (t) => {
  const half = Math.PI / n;
  return 1 + (Math.cos(half) / Math.cos(mod(t - rot, 2 * half) - half) - 1) * sharp;
};
const ellipse = (a: number, b: number, tilt: number): Radius => (t) =>
  (a * b) / Math.hypot(b * Math.cos(t - tilt), a * Math.sin(t - tilt));
const petals = (n: number, rot: number, depth: number, k: number): Radius => (t) =>
  1 - depth + depth * Math.pow(Math.abs(Math.cos((n * (t - rot)) / 2)), k);
const spikes = (n: number, rot: number, depth: number, k: number): Radius => (t) =>
  1 + depth * lobe(Math.cos(n * (t - rot)), k);
const bump = (t: number, at: number, width: number) =>
  Math.exp(-Math.pow(Math.atan2(Math.sin(t - at), Math.cos(t - at)) / width, 2));

interface Recipe {
  radius: Radius;
  soften: number;
}

const RECIPES: Record<BotShapeKind, (rand: Rand, pick: Choose) => Recipe> = {
  circle: () => ({ radius: () => 1, soften: 0 }),
  pill: (rand) => ({ radius: ellipse(1.32, 0.76, rand(-0.5, 0.5)), soften: 0 }),
  egg: () => ({ radius: (t) => ellipse(0.86, 1.08, 0)(t) * (1 + 0.1 * Math.sin(t)), soften: 0 }),
  triangle: (rand) => ({ radius: polygon(3, UP + rand(-0.25, 0.25), 0.9), soften: 10 }),
  square: (rand) => ({ radius: polygon(4, Math.PI / 4 + rand(-0.12, 0.12), 0.78), soften: 8 }),
  pentagon: (rand) => ({ radius: polygon(5, UP + rand(-0.3, 0.3), 0.95), soften: 6 }),
  hexagon: (rand) => ({ radius: polygon(6, rand(0, 1), 1), soften: 5 }),
  star4: (rand) => ({ radius: spikes(4, rand(-0.3, 0.3), 0.27, 1.7), soften: 3 }),
  star5: (rand) => ({ radius: spikes(5, UP + rand(-0.2, 0.2), 0.22, 1.5), soften: 3 }),
  clover: (rand) => ({ radius: petals(4, rand(-0.3, 0.3), 0.3, 0.6), soften: 4 }),
  flower: (_rand, pick) => ({ radius: petals(pick([5, 6]), UP, 0.26, 0.7), soften: 3 }),
  cloud: (rand, pick) => {
    const wide = ellipse(1.15, 0.9, 0);
    const scallops = petals(pick([7, 8, 9]), rand(0, 1), 0.16, 0.8);
    return { radius: (t) => wide(t) * scallops(t), soften: 2 };
  },
  drop: (rand) => {
    const tip = UP + rand(-0.5, 0.5);
    return { radius: (t) => 1 + 0.6 * bump(t, tip, 0.4), soften: 3 };
  },
  bean: (rand) => {
    const tilt = rand(-0.6, 0.6);
    const body = ellipse(1.25, 0.85, tilt);
    return { radius: (t) => body(t) - 0.24 * bump(t, tilt + UP, 0.5), soften: 3 };
  },
  dome: () => ({ radius: (t) => (Math.sin(t) < 0 ? ellipse(1, 1.05, 0)(t) : ellipse(1, 0.45, 0)(t)), soften: 7 }),
  splat: (rand, pick) => {
    const n = pick([6, 7, 8]);
    const rot = rand(0, 1);
    const heights = Array.from({ length: n }, () => rand(0.14, 0.34));
    return {
      radius: (t) => {
        const phase = (n * (t - rot)) / 2;
        const height = heights[Math.floor(mod(phase + Math.PI / 2, n * Math.PI) / Math.PI) % n] ?? 0.2;
        return 0.82 + height * Math.pow(Math.abs(Math.cos(phase)), 1.1);
      },
      soften: 2,
    };
  },
  pebble: (rand) => {
    const p = rand(0, TAU);
    const q = rand(0, TAU);
    return { radius: (t) => 1 + 0.13 * Math.cos(2 * t + p) + 0.1 * Math.cos(3 * t + q), soften: 0 };
  },
};

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) | 0, 7);

export interface BotShape {
  centre: readonly [number, number];
  /** Outline samples as [angle, radius] around `centre`. */
  polar: ReadonlyArray<readonly [number, number]>;
  mean: number;
  ground: number;
  width: number;
}

const shapes = new Map<BotShapeKind, BotShape>();

export function botShape(kind: BotShapeKind): BotShape {
  const known = shapes.get(kind);
  if (known) return known;
  const next = seeded(hash(kind) + 7919);
  const rand: Rand = (lo, hi) => lo + next() * (hi - lo);
  const pick: Choose = (list) => list[Math.floor(next() * list.length)]!;
  const { radius, soften } = RECIPES[kind](rand, pick);
  let radii = Array.from({ length: SAMPLES }, (_, i) => radius((i / SAMPLES) * TAU));
  for (let pass = 0; pass < soften; pass++) {
    radii = radii.map((r, i) => (radii[(i + SAMPLES - 1) % SAMPLES]! + 2 * r + radii[(i + 1) % SAMPLES]!) / 4);
  }
  const raw = radii.map((r, i) => [r * Math.cos((i / SAMPLES) * TAU), r * Math.sin((i / SAMPLES) * TAU)] as const);
  const xs = raw.map((point) => point[0]);
  const ys = raw.map((point) => point[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(...xs) - left;
  const height = Math.max(...ys) - top;
  const scale = SIZE / Math.max(width, height);
  const placed = raw.map(([x, y]) => [50 + (x - left - width / 2) * scale, 49 + (y - top - height / 2) * scale] as const);
  let area = 0;
  let cx = 0;
  let cy = 0;
  placed.forEach(([x, y], i) => {
    const [nx, ny] = placed[(i + 1) % SAMPLES]!;
    const cross = x * ny - nx * y;
    area += cross;
    cx += (x + nx) * cross;
    cy += (y + ny) * cross;
  });
  cx /= 3 * area;
  cy /= 3 * area;
  const polar = placed.map(([x, y]) => [Math.atan2(y - cy, x - cx), Math.hypot(x - cx, y - cy)] as const);
  const shape: BotShape = {
    centre: [cx, cy],
    polar,
    mean: polar.reduce((sum, point) => sum + point[1], 0) / SAMPLES,
    ground: 49 + (height * scale) / 2,
    width: width * scale,
  };
  shapes.set(kind, shape);
  return shape;
}

interface Posture {
  amp: number;
  ripple: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  rot: number;
  ex: number;
  ey: number;
  es: number;
  squint: number;
  red: number;
  work: number;
  happy: number;
  hurt: number;
}

const NEUTRAL: Posture = { amp: 1, ripple: 0, sx: 1, sy: 1, tx: 0, ty: 0, rot: 0, ex: 0, ey: 0, es: 1, squint: 1, red: 0, work: 0, happy: 0, hurt: 0 };

const POSTURES: Record<BotPose, (t: number, tau: number, offset: number) => Partial<Posture>> = {
  idle: () => ({}),
  working: (t, _tau, o) => {
    const s = Math.sin(t * 5 + o);
    return { work: 1, ripple: 1, sy: 1 + 0.05 * s, sx: 1 - 0.04 * s, ex: 4 * Math.sin(t * 2.6 + o), ey: 1.6, squint: 0.82 };
  },
  thinking: (t, _tau, o) => {
    const breath = 1 + 0.03 * Math.sin(t * 1.5 + o);
    return { work: 0.35, ripple: 0.5, sx: breath, sy: breath, amp: 1 + 0.1 * Math.sin(t * 1.1 + o), ex: 3.5 + 1.2 * Math.sin(t * 0.8 + o), ey: -3 };
  },
  asking: (t, _tau, o) => {
    const hop = Math.abs(Math.sin(t * 2.2 + o));
    return { ty: -4 * hop, sy: 1 + 0.04 * hop, sx: 1 - 0.03 * hop, rot: 6 * Math.sin(t * 2.2 + o), es: 1.18 };
  },
  done: (_t, tau) => {
    const fade = Math.exp(-tau * 2.4);
    const wobble = fade * Math.sin(tau * 16 + 1.2);
    return { happy: 1, ty: -10 * fade * Math.abs(Math.sin(tau * 8)), sy: 1 + 0.1 * wobble, sx: 1 - 0.08 * wobble };
  },
  error: (_t, tau) => ({ hurt: 1, red: 1, sy: 0.9, sx: 1.07, amp: 0.6, rot: -3, ey: 1.5, tx: tau % 2 < 0.5 ? 1.6 * Math.sin(tau * 40) : 0 }),
};

const BLINKS: Partial<Record<BotPose, true>> = { working: true, thinking: true, asking: true };

export type PoseWeights = Record<BotPose, number>;

export function poseWeights(pose: BotPose): PoseWeights {
  return Object.fromEntries(BOT_POSES.map((name) => [name, name === pose ? 1 : 0])) as PoseWeights;
}

/** Moves `weights` toward `pose` and reports whether any weight is still travelling. */
export function easePoseWeights(weights: PoseWeights, pose: BotPose, dtSeconds: number): boolean {
  const ease = 1 - Math.exp(-dtSeconds * 9);
  let moving = false;
  for (const name of BOT_POSES) {
    const goal = name === pose ? 1 : 0;
    const next = weights[name] + (goal - weights[name]) * ease;
    weights[name] = Math.abs(goal - next) < 0.002 ? goal : next;
    if (weights[name] !== goal) moving = true;
  }
  return moving;
}

export interface FigureMoment {
  /** Seconds on the shared clock. */
  t: number;
  /** Seconds since the pose was entered. */
  tau: number;
  /** Per-figure phase, so neighbours do not move in step. */
  offset: number;
  spin: number;
  gaze: { x: number; y: number };
  blinking: boolean;
  turn: number;
}

export interface FigureFrame {
  outline: string;
  alarm: string;
  shadow: string;
  shadowOpacity: string;
  body: string;
  face: string;
  eyes: string;
  eyesOpacity: string;
  happy: string;
  hurt: string;
  /** How fast the outline ripple advances, in the 0..1 range. */
  work: number;
}

export const STILL: FigureMoment = { t: 0, tau: 30, offset: 0, spin: 0, gaze: { x: 0, y: 0 }, blinking: false, turn: 0 };

export function poseBlinks(pose: BotPose, moment: Pick<FigureMoment, "t" | "offset">): boolean {
  return Boolean(BLINKS[pose]) && (moment.t * 0.33 + moment.offset * 0.137) % 1 < 0.035;
}

export function figureFrame(shape: BotShape, weights: PoseWeights, moment: FigureMoment): FigureFrame {
  const m: Posture = { ...NEUTRAL };
  for (const name of BOT_POSES) {
    const weight = weights[name];
    if (weight < 0.002) continue;
    const delta = POSTURES[name](moment.t, moment.tau, moment.offset);
    for (const key of Object.keys(delta) as Array<keyof Posture>) m[key] += ((delta[key] ?? NEUTRAL[key]) - NEUTRAL[key]) * weight;
  }
  const [cx, cy] = shape.centre;
  const ground = shape.ground;
  const points = shape.polar.map(([angle, radius], i) => {
    const r = (shape.mean + (radius - shape.mean) * m.amp) * (1 + m.ripple * 0.045 * Math.sin((3 * i * TAU) / SAMPLES - moment.spin * 4));
    return [cx + r * Math.cos(angle) * m.sx, ground + (cy + r * Math.sin(angle) - ground) * m.sy] as const;
  });
  const mid = (a: readonly [number, number], b: readonly [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
  const start = mid(points[SAMPLES - 1]!, points[0]!);
  let outline = `M${start[0].toFixed(1)} ${start[1].toFixed(1)}`;
  for (let i = 0; i < SAMPLES; i++) {
    const point = points[i]!;
    const next = mid(point, points[(i + 1) % SAMPLES]!);
    outline += `Q${point[0].toFixed(1)} ${point[1].toFixed(1)} ${next[0].toFixed(1)} ${next[1].toFixed(1)}`;
  }
  const faceX = cx.toFixed(2);
  const faceY = (ground + (cy + 2 - ground) * m.sy).toFixed(2);
  const lift = 1 + m.ty / 40;
  const eyeX = m.ex + moment.gaze.x * 3;
  const eyeY = m.ey + moment.gaze.y * 2.5;
  const lid = m.es * m.squint * (moment.blinking ? 0.1 : 1);
  return {
    outline: `${outline}Z`,
    alarm: (m.red * 0.9).toFixed(2),
    shadow: `translate(${(50 + m.tx).toFixed(2)} 0) scale(${lift.toFixed(3)} 1) translate(-50 0)`,
    shadowOpacity: lift.toFixed(2),
    body: `translate(${m.tx.toFixed(2)} ${m.ty.toFixed(2)}) rotate(${(m.rot + moment.turn).toFixed(2)} ${faceX} ${(moment.turn ? cy : ground).toFixed(1)})`,
    face: `translate(${faceX} ${faceY})`,
    eyes: `translate(${eyeX.toFixed(2)} ${eyeY.toFixed(2)}) scale(${m.es.toFixed(3)} ${lid.toFixed(3)})`,
    eyesOpacity: (1 - Math.max(m.happy, m.hurt)).toFixed(2),
    happy: m.happy.toFixed(2),
    hurt: m.hurt.toFixed(2),
    work: m.work,
  };
}

/** True when a figure settled in `pose` has nothing left to animate. */
export function poseRests(pose: BotPose, tau: number): boolean {
  return pose === "idle" || (pose === "done" && tau > 3);
}
