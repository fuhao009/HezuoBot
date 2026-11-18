/** Every body a bot can wear: the gradient catalog plus the Halloween bodies. */

import { z } from "zod";

import { DEFAULT_MASCOT_BODY, MASCOT_BODY_IDS } from "./mascot-bodies.ts";
import { HALLOWEEN_BODY_IDS, type HalloweenBodyId } from "./halloween-bodies.ts";

export const BOT_BODY_IDS = [...MASCOT_BODY_IDS, ...HALLOWEEN_BODY_IDS] as const;

export type BotBodyId = (typeof BOT_BODY_IDS)[number];

export const botBodySchema = z.enum(BOT_BODY_IDS);

/** Runtime-safe read of an untrusted persisted or streamed body id. */
export function botBodyId(value: unknown): BotBodyId {
  return botBodySchema.safeParse(value).data ?? DEFAULT_MASCOT_BODY;
}

export function isHalloweenBody(value: unknown): value is HalloweenBodyId {
  return (HALLOWEEN_BODY_IDS as readonly unknown[]).includes(value);
}

/** The body a bot wears: the one chosen for it, else one of the catalog fixed by its id, so bots that never chose
 * still look different from each other. */
export function bodyOfBot(bot: { id?: string; mascotBody?: BotBodyId | null }): BotBodyId {
  if (bot.mascotBody) return bot.mascotBody;
  if (!bot.id) return DEFAULT_MASCOT_BODY;
  let hash = 0;
  for (const char of bot.id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return MASCOT_BODY_IDS[hash % MASCOT_BODY_IDS.length]!;
}
