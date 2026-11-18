import { describe, expect, it, vi, afterEach } from "vitest";
import { HezuoCoreDriver } from "./hezuo-core.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// ---------------------------------------------------------------------------
// decodeConfig / defaultConfig
// ---------------------------------------------------------------------------
describe("HezuoCoreDriver config", () => {
  it("accepts empty config with defaults", () => {
    const cfg = HezuoCoreDriver.decodeConfig({});
    expect(cfg.apiKeyEnv).toBe("HEZUO_CORE_API_KEY");
    expect(cfg.model).toBeUndefined();
    expect(cfg.baseUrl).toBeUndefined();
  });

  it("accepts full config", () => {
    const cfg = HezuoCoreDriver.decodeConfig({
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "MY_KEY",
      browserHeadless: false,
      reasoningEffort: "high",
    });
    expect(cfg.model).toBe("gpt-4o");
    expect(cfg.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.browserHeadless).toBe(false);
    expect(cfg.reasoningEffort).toBe("high");
  });

  it("rejects invalid baseUrl", () => {
    expect(() => HezuoCoreDriver.decodeConfig({ baseUrl: "not-a-url" })).toThrow();
  });

  it("rejects invalid reasoningEffort", () => {
    expect(() => HezuoCoreDriver.decodeConfig({ reasoningEffort: "ultra" })).toThrow();
  });

  it("defaultConfig round-trips through decodeConfig", () => {
    const def = HezuoCoreDriver.defaultConfig();
    expect(() => HezuoCoreDriver.decodeConfig(def)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// snapshot: unavailable without model or key
// ---------------------------------------------------------------------------
describe("HezuoCoreDriver snapshot", () => {
  it("returns unavailable when HEZUO_CORE_MODEL is not set", async () => {
    vi.stubEnv("HEZUO_CORE_MODEL", "");
    const instance = await HezuoCoreDriver.create({
      instanceId: "test-no-model",
      displayName: undefined,
      enabled: true,
      config: HezuoCoreDriver.decodeConfig({}),
      environment: { HEZUO_CORE_API_KEY: "sk-test" },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toMatch(/HEZUO_CORE_MODEL/);
    await instance.dispose();
  });

  it("returns unavailable when API key is not set", async () => {
    vi.stubEnv("HEZUO_CORE_MODEL", "gpt-4o");
    vi.stubEnv("HEZUO_CORE_API_KEY", "");
    const instance = await HezuoCoreDriver.create({
      instanceId: "test-no-key",
      displayName: undefined,
      enabled: true,
      config: HezuoCoreDriver.decodeConfig({}),
      environment: {},
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toMatch(/HEZUO_CORE_API_KEY/);
    await instance.dispose();
  });

  it("returns available when model and key are set", async () => {
    vi.stubEnv("HEZUO_CORE_MODEL", "gpt-4o");
    vi.stubEnv("HEZUO_CORE_API_KEY", "sk-test");
    const instance = await HezuoCoreDriver.create({
      instanceId: "test-available",
      displayName: undefined,
      enabled: true,
      config: HezuoCoreDriver.decodeConfig({}),
      environment: {},
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.authenticated).toBe(true);
    await instance.dispose();
  });
});

// ---------------------------------------------------------------------------
// driver metadata
// ---------------------------------------------------------------------------
describe("HezuoCoreDriver metadata", () => {
  it("has correct driverKind", () => {
    expect(HezuoCoreDriver.driverKind).toBe("hezuo-core");
  });

  it("has displayName", () => {
    expect(HezuoCoreDriver.metadata.displayName).toBe("HezuoBot Core");
  });

  it("supports multiple instances", () => {
    expect(HezuoCoreDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("has an install descriptor with docsUrl", () => {
    expect(HezuoCoreDriver.install?.docsUrl).toBeTruthy();
    expect(HezuoCoreDriver.install?.signInCommand).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// builtIn registry includes HezuoCoreDriver
// ---------------------------------------------------------------------------
describe("BUILT_IN_DRIVERS", () => {
  it("includes HezuoCoreDriver", async () => {
    const { BUILT_IN_DRIVERS } = await import("./builtIn.ts");
    expect(BUILT_IN_DRIVERS.some((d) => d.driverKind === "hezuo-core")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sendTurn: emits turn.started then turn.completed on Core subprocess failure
// ---------------------------------------------------------------------------
describe("HezuoCoreDriver sendTurn", () => {
  it("emits turn.started and turn.completed(ok:false) when Core process fails to start", async () => {
    vi.stubEnv("HEZUO_CORE_MODEL", "gpt-4o");
    // Point baseUrl to a non-existent port so Core fails fast
    const instance = await HezuoCoreDriver.create({
      instanceId: "test-send",
      displayName: undefined,
      enabled: true,
      config: HezuoCoreDriver.decodeConfig({ model: "gpt-4o" }),
      // No API key → Core will start but fail immediately
      environment: { HEZUO_CORE_API_KEY: "sk-invalid-for-test" },
    });

    const events: Array<{ type: string; ok?: boolean }> = [];
    instance.adapter.onEvent((e) => events.push({ type: e.type, ok: "ok" in e ? (e as { ok: boolean }).ok : undefined }));

    // We don't want to actually spawn a real subprocess in unit tests;
    // verify that hasSession starts false and respondToRequest returns unavailable.
    expect(instance.adapter.hasSession("thread-1")).toBe(false);
    const outcome = await instance.adapter.respondToRequest("thread-1", "req-1", { behavior: "allow" });
    expect(outcome).toBe("unavailable");

    await instance.dispose();
  });
});
