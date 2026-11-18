/** The bodies a bot can wear. Each stored id names one of the generated shapes. */

import { z } from "zod";

export const BOT_SHAPE_KINDS = [
  "circle",
  "pill",
  "egg",
  "triangle",
  "square",
  "pentagon",
  "hexagon",
  "star4",
  "star5",
  "clover",
  "flower",
  "cloud",
  "drop",
  "bean",
  "dome",
  "splat",
  "pebble",
] as const;

export type BotShapeKind = (typeof BOT_SHAPE_KINDS)[number];

/** Every selectable body id, in the order the picker shows them. */
export const MASCOT_BODY_IDS = [
  "cursor",
  "blob",
  "circle",
  "squircle",
  "capsule",
  "drop",
  "shield",
  "hexagon",
  "diamond",
  "star",
  "egg",
  "pentagon",
  "clover",
  "flower",
  "cloud",
  "bean",
  "splat",
] as const;

export type MascotBodyId = (typeof MASCOT_BODY_IDS)[number];

export const mascotBodySchema = z.enum(MASCOT_BODY_IDS);

export interface MascotBody {
  id: MascotBodyId;
  /** Human-readable name, used for the picker and the accessible label. */
  name: string;
  shape: BotShapeKind;
}

/** The body a new bot wears, and the fallback for any unrecognised value. */
export const DEFAULT_MASCOT_BODY: MascotBodyId = "cursor";

export const MASCOT_BODIES: Record<MascotBodyId, MascotBody> = {
  cursor: { id: "cursor", name: "Triangle", shape: "triangle" },
  blob: { id: "blob", name: "Pebble", shape: "pebble" },
  circle: { id: "circle", name: "Circle", shape: "circle" },
  squircle: { id: "squircle", name: "Square", shape: "square" },
  capsule: { id: "capsule", name: "Capsule", shape: "pill" },
  drop: { id: "drop", name: "Drop", shape: "drop" },
  shield: { id: "shield", name: "Dome", shape: "dome" },
  hexagon: { id: "hexagon", name: "Hexagon", shape: "hexagon" },
  diamond: { id: "diamond", name: "Twinkle", shape: "star4" },
  star: { id: "star", name: "Star", shape: "star5" },
  egg: { id: "egg", name: "Egg", shape: "egg" },
  pentagon: { id: "pentagon", name: "Pentagon", shape: "pentagon" },
  clover: { id: "clover", name: "Clover", shape: "clover" },
  flower: { id: "flower", name: "Flower", shape: "flower" },
  cloud: { id: "cloud", name: "Cloud", shape: "cloud" },
  bean: { id: "bean", name: "Bean", shape: "bean" },
  splat: { id: "splat", name: "Splat", shape: "splat" },
};

/** Runtime-safe read of an untrusted persisted or streamed body id. */
export function botMascotBody(value: unknown): MascotBodyId {
  return mascotBodySchema.safeParse(value).data ?? DEFAULT_MASCOT_BODY;
}
