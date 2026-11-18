import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
}

let local: ReturnType<typeof memoryStorage>;

// The module keeps a per-session choice, so each case loads a fresh copy over the same storage, as a relaunch would.
async function fresh() {
  vi.resetModules();
  return import("./interface-mode");
}

beforeEach(() => {
  local = memoryStorage();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("interface mode", () => {
  it("is Simple on a fresh install and on one that ran before", async () => {
    expect((await fresh()).readAdvancedMode()).toBe(false);
    local.setItem("omb-skin", "lagoon");
    expect((await fresh()).readAdvancedMode()).toBe(false);
  });

  it("does not carry over the choice an earlier version stored", async () => {
    local.setItem("omb-advanced-mode", "1");
    expect((await fresh()).readAdvancedMode()).toBe(false);
  });

  it("keeps an explicit choice across a relaunch", async () => {
    (await fresh()).setAdvancedMode(true);
    expect((await fresh()).readAdvancedMode()).toBe(true);
    (await fresh()).setAdvancedMode(false);
    expect((await fresh()).readAdvancedMode()).toBe(false);
  });

  it("still switches for the session when storage throws", async () => {
    const { setAdvancedMode, readAdvancedMode } = await fresh();
    local.setItem.mockImplementation(() => {
      throw new Error("quota");
    });
    setAdvancedMode(true);
    expect(readAdvancedMode()).toBe(true);
  });

  it("falls back to Simple when storage cannot be read at all", async () => {
    local.getItem.mockImplementation(() => {
      throw new Error("blocked");
    });
    expect((await fresh()).readAdvancedMode()).toBe(false);
  });
});
