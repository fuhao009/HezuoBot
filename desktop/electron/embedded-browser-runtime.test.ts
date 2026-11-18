import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ activate: vi.fn(), takeover: vi.fn(), closeTakeover: vi.fn(), callbacks: null as null | { onFallbackClose: (value: Record<string, unknown>) => void } }));
vi.mock("./embedded-browser-cdp.mjs", () => ({ createEmbeddedBrowserBroker: () => ({ activateTarget: fixture.activate, close: async () => {}, closeLeases: async () => {} }) }));
vi.mock("./embedded-browser-surface.mjs", () => ({
  embeddedBrowserPartition: () => "fixture",
  createEmbeddedBrowserSurfaceManager: (callbacks: NonNullable<typeof fixture.callbacks>) => {
    fixture.callbacks = callbacks;
    return { takeover: fixture.takeover, closeTakeover: fixture.closeTakeover, dispose: async () => {}, closeAll: async () => {} };
  },
}));
import { createEmbeddedBrowserRuntime } from "./embedded-browser-runtime.mjs";
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function setup() {
  fixture.activate.mockReset(); fixture.takeover.mockReset().mockReturnValue(true);
  fixture.closeTakeover.mockReset().mockImplementation(value => fixture.callbacks?.onFallbackClose(value));
  const sent: Array<Record<string, unknown>> = [];
  const states: Array<Record<string, unknown>> = [];
  const contents = Object.assign(new EventEmitter(), { send: (_channel: string, state: Record<string, unknown>) => states.push(state) });
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents });
  const runtime = createEmbeddedBrowserRuntime({ proc: { postMessage: (value: Record<string, unknown>) => sent.push(value) }, dataDir: "/tmp/fixture", accountKey: "fixture", session: {}, owner: () => owner, current: () => true });
  return { runtime, sent, states };
}

it("rejects revoked authority received while native target activation is awaiting", async () => {
  const { runtime, sent } = setup();
  const activation = Promise.withResolvers<boolean>();
  fixture.activate.mockReturnValue(activation.promise);
  const opening = runtime.takeover({ botId: "bot", viewerId: "viewer", title: "Bot" });
  const requestId = sent[0]!.requestId;
  runtime.receive({ type: "hezuo:embedded-surface-resolved", requestId, ok: true, profileKey: "profile", state: { canOperate: true, controls: true, hidden: false, targetId: "page" } });
  await tick();
  runtime.receive({ type: "hezuo:embedded-surface-state", subscriptionId: requestId, state: { canOperate: false, controls: false, hidden: true, targetId: "page" } });
  activation.resolve(true);
  await expect(opening).rejects.toThrow("Browser control required");
  expect(fixture.takeover).not.toHaveBeenCalled();
  expect(sent).toContainEqual({ type: "hezuo:embedded-surface-detach", subscriptionId: requestId });
  await runtime.close();
});

it("reports runtime disposal as error rather than user handback", async () => {
  const { runtime, sent, states } = setup();
  fixture.activate.mockResolvedValue(true);
  const opening = runtime.takeover({ botId: "bot", viewerId: "viewer", title: "Bot" });
  runtime.receive({ type: "hezuo:embedded-surface-resolved", requestId: sent[0]!.requestId, ok: true, profileKey: "profile", state: { canOperate: true, controls: true, hidden: false, targetId: "page" } });
  await opening;
  await runtime.close();
  expect(states).toContainEqual(expect.objectContaining({ status: "error" }));
  expect(states).not.toContainEqual(expect.objectContaining({ status: "closed" }));
});
