import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rejectObsoleteServerEnv } from "./obsolete-server-env.ts";

// Dynamic config imports exercise import-time validation after each environment setup.

beforeEach(() => {
  // The shared setup can load config before the test sets its environment.
  vi.resetModules();
  vi.stubEnv("OMB_DATA_DIR", undefined);
  vi.stubEnv("OMB_LOOPBACK_TRUST", undefined);
  vi.stubEnv("OGB_PORT", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  { obsolete: "OMB_DATA_DIR", replacement: "HEZUO_DATA_DIR", value: "/obsolete-data" },
  { obsolete: "OMB_LOOPBACK_TRUST", replacement: "HEZUO_LOOPBACK_TRUST", value: "owner" },
  { obsolete: "OGB_PORT", replacement: "HEZUO_PORT", value: "8799" },
])("rejects $obsolete when importing configuration", async ({ obsolete, replacement, value }) => {
  vi.stubEnv(obsolete, value);
  vi.stubEnv(replacement, undefined);

  await expect(import("./config.ts")).rejects.toThrow(`Unset ${obsolete}; use ${replacement} instead.`);
});

it("reports all obsolete variables even when empty and their replacements are set", async () => {
  vi.stubEnv("OMB_DATA_DIR", "");
  vi.stubEnv("OMB_LOOPBACK_TRUST", "");
  vi.stubEnv("OGB_PORT", "");
  vi.stubEnv("HEZUO_DATA_DIR", "/configured-data");
  vi.stubEnv("HEZUO_LOOPBACK_TRUST", "service");
  vi.stubEnv("HEZUO_PORT", "8800");

  await expect(import("./config.ts")).rejects.toThrow(
    "Unset OMB_DATA_DIR; use HEZUO_DATA_DIR instead. Unset OMB_LOOPBACK_TRUST; use HEZUO_LOOPBACK_TRUST instead. Unset OGB_PORT; use HEZUO_PORT instead.",
  );
});

it("accepts HEZUO_PORT without OGB_PORT", () => {
  vi.stubEnv("HEZUO_PORT", "8800");

  expect(() => rejectObsoleteServerEnv(process.env)).not.toThrow();
});
