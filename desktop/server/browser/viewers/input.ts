import { requestedSize, VIEWPORT_PRESETS, type ViewportSetting } from "./viewport.ts";

/** Only scrolling sends reduced frames; an animation stays sharp. */
export const MOTION_FRAMES = 4;
export const MOTION_WINDOW_MS = 300;
export const MOTION_QUALITY = 50;
export const TEXT_LIMIT = 10_000;
export const HELD_LIMIT = 64;
export const CURSOR_EVERY_MS = 120;

export const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
export const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);
export const modifiersOf = (message: Record<string, unknown>) => {
  const value = num(message.modifiers);
  return Number.isInteger(value) && value >= 0 && value < 16 ? value : 0;
};

export const appliedKey = (size: { width: number; height: number }, zoom: number) => `${size.width}x${size.height}@${zoom}`;

export function parseSetting(value: unknown): ViewportSetting | null {
  const setting = record(value);
  if (!setting) return null;
  if (setting.mode === "fill") return { mode: "fill" };
  if (setting.mode === "preset" && typeof setting.preset === "string" && setting.preset in VIEWPORT_PRESETS) {
    return { mode: "preset", preset: setting.preset as keyof typeof VIEWPORT_PRESETS, ...(setting.landscape === true ? { landscape: true } : {}) };
  }
  if (setting.mode === "fixed") {
    const size = requestedSize(setting.width, setting.height);
    return size ? { mode: "fixed", ...size } : null;
  }
  return null;
}
