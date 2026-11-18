/** The costumes of the Halloween skin. Each costume id names one of the generated shapes. */

import type { BotShapeKind } from "./mascot-bodies.ts";

export const HALLOWEEN_BODY_IDS = ["pumpkin", "ghost", "witch", "bat", "cat", "skull", "monster", "mummy", "vampire", "spider"] as const;

export type HalloweenBodyId = (typeof HALLOWEEN_BODY_IDS)[number];

export interface HalloweenBody {
  id: HalloweenBodyId;
  name: string;
  shape: BotShapeKind;
}

export const HALLOWEEN_BODIES: Record<HalloweenBodyId, HalloweenBody> = {
  pumpkin: { id: "pumpkin", name: "Pumpkin", shape: "clover" },
  ghost: { id: "ghost", name: "Ghost", shape: "dome" },
  witch: { id: "witch", name: "Witch", shape: "triangle" },
  bat: { id: "bat", name: "Bat", shape: "star4" },
  cat: { id: "cat", name: "Cat", shape: "bean" },
  skull: { id: "skull", name: "Skull", shape: "egg" },
  monster: { id: "monster", name: "Monster", shape: "splat" },
  mummy: { id: "mummy", name: "Mummy", shape: "pill" },
  vampire: { id: "vampire", name: "Vampire", shape: "pentagon" },
  spider: { id: "spider", name: "Spider", shape: "star5" },
};
