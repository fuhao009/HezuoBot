import { MASCOT_BODY_IDS, type MascotBodyId } from "../shared/mascot-bodies.ts";
import { HEZUO_COLOR_NAMES, type HezuoColor } from "../shared/wire.ts";

export const STARTER_COLORS: readonly HezuoColor[] = HEZUO_COLOR_NAMES.filter((color) => color !== "silver" && color !== "chrome");
const ROTATION: readonly HezuoColor[] = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];

/** The colour of the bot made `index`-th when nothing else picks one. */
export const rotationColor = (index: number): HezuoColor => ROTATION[index % ROTATION.length]!;

/** A new bot's first look: a random colour and a random shape, each one no bot here wears yet when one is left. */
export function freshLook(
  bots: ReadonlyArray<{ color: HezuoColor; mascotBody?: string | null }>,
  random: () => number = Math.random,
): { color: HezuoColor; mascotBody: MascotBodyId } {
  const unworn = <T>(all: readonly T[], worn: (value: T) => boolean): T => {
    const free = all.filter((value) => !worn(value));
    const pool = free.length ? free : all;
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
  };
  return {
    color: unworn(STARTER_COLORS, (color) => bots.some((bot) => bot.color === color)),
    mascotBody: unworn(MASCOT_BODY_IDS, (body) => bots.some((bot) => bot.mascotBody === body)),
  };
}
