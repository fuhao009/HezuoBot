import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// DATA_DIR is initialized at import time, so each environment case needs a fresh module load.
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("OMB_DATA_DIR", undefined);
  vi.stubEnv("OMB_LOOPBACK_TRUST", undefined);
  vi.stubEnv("OGB_PORT", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("defaults to the current Hezuo data directory", async () => {
  vi.stubEnv("HEZUO_DATA_DIR", undefined);
  const { DATA_DIR, EVENTS_DIR, NATIVE_DIR } = await import("./config.ts");
  expect(DATA_DIR).toBe(join(homedir(), ".hezuo"));
  expect(EVENTS_DIR).toBe(join(DATA_DIR, "events"));
  expect(NATIVE_DIR).toBe(join(DATA_DIR, "native"));
});

it.each(["/configured-data", ""])("preserves the explicit HEZUO_DATA_DIR value %j", async (directory) => {
  vi.stubEnv("HEZUO_DATA_DIR", directory);
  const { DATA_DIR, EVENTS_DIR, NATIVE_DIR } = await import("./config.ts");
  expect(DATA_DIR).toBe(directory);
  expect(EVENTS_DIR).toBe(join(directory, "events"));
  expect(NATIVE_DIR).toBe(join(directory, "native"));
});
