import { beforeEach, expect, it, vi } from "vitest";
import type { PreviewStreamEvents, PreviewStreamInput } from "./browser-stream-client";

const fixture = vi.hoisted(() => ({ events: [] as PreviewStreamEvents[], sends: [] as PreviewStreamInput[], answer: vi.fn() }));
vi.mock("./sign-in", () => ({ answerSignIn: (...args: unknown[]) => fixture.answer(...args) }));
vi.mock("./browser-stream-client", () => ({
  browserStreamAccess: vi.fn(() => ({})),
  createPreviewStreamClient: (_target: unknown, events: PreviewStreamEvents) => {
    fixture.events.push(events);
    return { stop: vi.fn(), send: (input: PreviewStreamInput) => { fixture.sends.push(input); return true; } };
  },
}));
import { cancelBrowserTakeover, requestBrowserTakeover } from "./browser-takeover";

const ref = { botId: "a", threadId: "thread", messageId: "card", place: "browser" as const };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => { fixture.events.length = 0; fixture.sends.length = 0; fixture.answer.mockReset().mockResolvedValue(undefined); });

it("waits for server control, reuses the page window, releases before answering done", async () => {
  let receive!: (state: EmbeddedBrowserSurfaceState) => void;
  const surface: EmbeddedBrowserSurfaceState = { surfaceId: "surface", revision: 1, status: "ready", visible: true, interactive: true };
  const takeover = vi.fn(async () => surface);
  vi.stubGlobal("window", { location: {}, hezuo: { browserSurface: { takeover, onState: (cb: typeof receive) => { receive = cb; return () => {}; } } } });
  const opened = requestBrowserTakeover(ref, "A");
  const repeated = requestBrowserTakeover(ref, "A");
  const events = fixture.events[0]!;
  events.onMessage?.({ type: "surface", viewerId: "authorized-viewer" });
  await tick();
  expect(takeover).not.toHaveBeenCalled();
  events.onControl?.({ canOperate: true, controller: "you", generation: 1, dialog: null });
  await opened;
  await repeated;
  expect(takeover).toHaveBeenCalledWith(expect.objectContaining({ viewerId: "authorized-viewer", botId: "a" }));
  await requestBrowserTakeover(ref, "A");
  expect(fixture.events).toHaveLength(1);
  receive({ ...surface, status: "closed" });
  expect(fixture.sends.at(-1)).toEqual({ type: "releaseControl" });
  expect(fixture.answer).not.toHaveBeenCalled();
  events.onControl?.({ canOperate: true, controller: "agent", generation: 2, dialog: null });
  await tick();
  expect(fixture.answer).toHaveBeenCalledExactlyOnceWith(ref, "done");
});

it("does not create an unauthorized browser window", async () => {
  const takeover = vi.fn();
  vi.stubGlobal("window", { location: {}, hezuo: { browserSurface: { takeover, onState: () => () => {} } } });
  const opened = requestBrowserTakeover({ ...ref, botId: "denied" }, "Denied");
  fixture.events[0]!.onControl?.({ canOperate: false, controller: "unclaimed", generation: 1, dialog: null });
  fixture.events[0]!.onUnauthorized();
  await expect(opened).rejects.toThrow();
  expect(takeover).not.toHaveBeenCalled();
  expect(fixture.answer).not.toHaveBeenCalled();
});

it("reports missing release acknowledgement without answering done", async () => {
  vi.useFakeTimers();
  let receive!: (state: EmbeddedBrowserSurfaceState) => void;
  const surface: EmbeddedBrowserSurfaceState = { surfaceId: "timeout", revision: 1, status: "ready", visible: true, interactive: true };
  const onError = vi.fn();
  vi.stubGlobal("window", { location: {}, hezuo: { browserSurface: { takeover: async () => surface, onState: (cb: typeof receive) => { receive = cb; return () => {}; } } } });
  const opened = requestBrowserTakeover({ ...ref, botId: "timeout" }, "Timeout", onError);
  fixture.events[0]!.onMessage?.({ type: "surface", viewerId: "viewer" });
  fixture.events[0]!.onControl?.({ canOperate: true, controller: "you", generation: 1, dialog: null });
  await opened;
  receive({ ...surface, status: "closed" });
  await vi.advanceTimersByTimeAsync(8_000);
  expect(onError).toHaveBeenCalled();
  expect(fixture.answer).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it("cancels a late native grant without answering done or replaying control", async () => {
  const grant = Promise.withResolvers<EmbeddedBrowserSurfaceState>();
  const closeTakeover = vi.fn(async () => {});
  vi.stubGlobal("window", { location: {}, hezuo: { browserSurface: { takeover: () => grant.promise, closeTakeover, onState: () => () => {} } } });
  const request = { ...ref, botId: "late" };
  const opened = requestBrowserTakeover(request, "Late");
  const events = fixture.events[0]!;
  events.onMessage?.({ type: "surface", viewerId: "late-viewer" });
  events.onControl?.({ canOperate: true, controller: "you", generation: 1, dialog: null });
  const cancelled = cancelBrowserTakeover(request);
  const count = fixture.sends.length;
  events.onConnectedChange(true);
  events.onControl?.({ canOperate: true, controller: "agent", generation: 2, dialog: null });
  expect(fixture.sends).toHaveLength(count);
  const surface: EmbeddedBrowserSurfaceState = { surfaceId: "late", revision: 1, status: "ready", visible: true, interactive: true };
  grant.resolve(surface);
  await cancelled;
  await opened;
  expect(closeTakeover).toHaveBeenCalledWith(surface);
  expect(fixture.answer).not.toHaveBeenCalled();
});

it.each(["cancel", "revoke", "close"] as const)("renews only its visible authorized hold until %s", async reason => {
  vi.useFakeTimers();
  let receive!: (state: EmbeddedBrowserSurfaceState) => void;
  const surface: EmbeddedBrowserSurfaceState = { surfaceId: reason, revision: 1, status: "ready", visible: true, interactive: true };
  const closeTakeover = vi.fn(async () => {});
  vi.stubGlobal("window", { location: {}, hezuo: { browserSurface: { takeover: async () => surface, closeTakeover, onState: (cb: typeof receive) => { receive = cb; return () => {}; } } } });
  const request = { ...ref, botId: `renew-${reason}` };
  const opened = requestBrowserTakeover(request, "Renew");
  const events = fixture.events[0]!;
  events.onMessage?.({ type: "surface", viewerId: "renew-viewer" });
  events.onControl?.({ canOperate: true, controller: "you", generation: 1, dialog: null });
  await opened;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fixture.sends.at(-1)).toEqual({ type: "renewControl" });
  await cancelBrowserTakeover({ ...request, messageId: "stale" });
  const before = fixture.sends.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fixture.sends.length).toBe(before + 1);
  if (reason === "cancel") await cancelBrowserTakeover(request);
  else if (reason === "revoke") events.onControl?.({ canOperate: false, controller: "agent", generation: 2, dialog: null });
  else {
    receive({ ...surface, status: "closed" });
    events.onControl?.({ canOperate: true, controller: "agent", generation: 2, dialog: null });
    await tick();
  }
  const stopped = fixture.sends.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fixture.sends).toHaveLength(stopped);
  if (reason !== "close") expect(fixture.answer).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it("cancels before viewer authority arrives and ignores stale callbacks", async () => {
  const takeover = vi.fn();
  vi.stubGlobal("window", { location: {}, hezuo: { browserSurface: { takeover, onState: () => () => {} } } });
  const request = { ...ref, botId: "early-cancel" };
  const opened = requestBrowserTakeover(request, "Early");
  const events = fixture.events[0]!;
  await cancelBrowserTakeover(request);
  await opened;
  events.onMessage?.({ type: "surface", viewerId: "old" });
  events.onConnectedChange(true);
  events.onControl?.({ canOperate: true, controller: "you", generation: 1, dialog: null });
  await tick();
  expect(takeover).not.toHaveBeenCalled();
  expect(fixture.answer).not.toHaveBeenCalled();
});
