import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const listeners = new Map();
const exposed = { name: null, api: null };
const invocations = [];
const fakeIpcRenderer = {
  on: (channel, handler) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(handler);
  },
  removeListener: (channel, handler) => {
    listeners.get(channel)?.delete(handler);
  },
  invoke: async (...args) => { invocations.push(args); },
  send: (...args) => { invocations.push(args); },
  sendSync: (...args) => { invocations.push(args); return null; },
};
const fakeElectron = {
  ipcRenderer: fakeIpcRenderer,
  contextBridge: {
    exposeInMainWorld: (name, api) => {
      exposed.name = name;
      exposed.api = api;
    },
  },
  webUtils: { getPathForFile: () => "" },
};

const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const localOrigin = "http://127.0.0.1:43123";
runInNewContext(source, {
  require: (name) => { assert.equal(name, "electron"); return fakeElectron; },
  process: { platform: process.platform, argv: [`--hezuo-local-origin=${localOrigin}`] },
  location: { origin: localOrigin },
  navigator: { userActivation: { isActive: false } },
  queueMicrotask,
}, { filename: "preload.cjs" });

const emit = (channel, ...args) => {
  for (const handler of listeners.get(channel) ?? []) handler({}, ...args);
};
const subscriberCount = (channel) => listeners.get(channel)?.size ?? 0;

test("exposes the full local-shell bridge on window.hezuo", () => {
  assert.equal(exposed.name, "hezuo");
  assert.equal(typeof exposed.api, "object");
  assert.equal(typeof exposed.api.onOpenAppSettings, "function");
});

test("openLogsFolder asks main for its own logs folder and names no path", async () => {
  const before = invocations.length;
  await exposed.api.openLogsFolder("C:\\Windows\\System32");
  assert.deepEqual(invocations.slice(before), [["desktop:open-logs"]]);
});

test("copyText forwards only the text over the explicit clipboard:write-text channel", async () => {
  const before = invocations.length;
  await exposed.api.copyText("hello");
  assert.deepEqual(invocations.slice(before), [["clipboard:write-text", "hello"]]);
  assert.equal("ipcRenderer" in exposed.api, false);
});

test("browser control forwards a separate per-device capability", async () => {
  const before = invocations.length;
  await exposed.api.companion.browserControl("phone-1", true);
  await exposed.api.companion.browserControl("phone-1", false);
  assert.deepEqual(invocations.slice(before), [
    ["companion:browser-control", "phone-1", true],
    ["companion:browser-control", "phone-1", false],
  ]);
});

test("the talk bridge asks main over its own channels with only what it understands", async () => {
  const before = invocations.length;
  await exposed.api.talkShortcut.state();
  await exposed.api.talkShortcut.set({ enabled: false, key: "ctrl-shift-space", extra: "x" });
  await exposed.api.callActive(true);
  await exposed.api.callActive("yes");
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.slice(before))), [["talk-shortcut:state"], ["talk-shortcut:set", { enabled: false, key: "ctrl-shift-space" }], ["call:active", true], ["call:active", false]]);
});

test("onOpenAppSettings subscribes to the exact app:open-settings channel, forwards every emit, and unsubscribes cleanly", () => {
  // main.mjs sends "app:open-settings"; a different name would leave the shortcut inert while menu tests still pass.
  const cbCalls = [];
  const unsubscribe = exposed.api.onOpenAppSettings(() => cbCalls.push(1));
  assert.equal(subscriberCount("app:open-settings"), 1);

  emit("app:open-settings");
  emit("app:open-settings");
  assert.equal(cbCalls.length, 2);

  unsubscribe();
  assert.equal(subscriberCount("app:open-settings"), 1, "the preload retains its cold-start listener");
  emit("app:open-settings");
  assert.equal(cbCalls.length, 2);
});

test("an organisation action arriving before React subscriptions is delivered exactly once after mount", async () => {
  emit("app:open-settings", "organization");
  const calls = [];
  const unsubscribe = exposed.api.onOpenAppSettings(section => calls.push(["app", section]));
  const unsubscribePanel = exposed.api.onOpenAppSettings(section => calls.push(["panel", section]));
  assert.deepEqual(calls, []);
  await Promise.resolve();
  assert.deepEqual(calls, [["app", "organization"], ["panel", "organization"]]);
  unsubscribe(); unsubscribePanel();
  const late = exposed.api.onOpenAppSettings(section => calls.push(["late", section]));
  await Promise.resolve();
  assert.equal(calls.length, 2, "later subscriptions must not reopen Settings");
  late();
});

test("a transient subscription cannot consume a cold-start action before the actual mount", async () => {
  emit("app:open-settings", "organization");
  const calls = [];
  exposed.api.onOpenAppSettings(section => calls.push(section))();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  const unsubscribe = exposed.api.onOpenAppSettings(section => calls.push(section));
  await Promise.resolve();
  assert.deepEqual(calls, ["organization"]);
  unsubscribe();
});

test("native Settings requests accept only the fixed organisation section", () => {
  const calls = [];
  const unsubscribe = exposed.api.onOpenAppSettings(section => calls.push(section));
  emit("app:open-settings", "organization");
  emit("app:open-settings", "cloud");
  emit("app:open-settings", "cloud-settings");
  emit("app:open-settings", "https://other.example");
  emit("app:open-settings", "cloudAccount");
  emit("app:open-settings", "hezuobot://cloud");
  emit("app:open-settings", { section: "organization", url: "https://other.example" });
  emit("app:open-settings", ["cloud"]);
  assert.deepEqual(calls, ["organization", undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  unsubscribe();
});

test("unrecognised Settings requests are not retained before subscriptions mount", async () => {
  emit("app:open-settings", "https://other.example");
  emit("app:open-settings", "cloud");
  const calls = [];
  const unsubscribe = exposed.api.onOpenAppSettings(section => calls.push(section));
  await Promise.resolve();
  assert.deepEqual(calls, []);
  unsubscribe();
  const late = exposed.api.onOpenAppSettings(section => calls.push(section));
  await Promise.resolve();
  assert.deepEqual(calls, [], "unrecognised requests must not reopen Settings");
  late();
});

test("local permission and policy controls use dedicated native channels", async () => {
  const before = invocations.length;
  await exposed.api.permStatus();
  await exposed.api.permRequestMic();
  await exposed.api.permOpenSettings("microphone");
  await exposed.api.localControl.status();
  await exposed.api.localControl.enable();
  await exposed.api.localControl.disable();
  await exposed.api.localControl.retry();
  await exposed.api.computerUsePolicy.get();
  const policy = { enabled: false };
  await exposed.api.computerUsePolicy.set(policy);
  await exposed.api.approvals.setMode("bot-1", "custom", { source: "settings" });
  assert.deepEqual(invocations.slice(before), [
    ["perm:status"], ["perm:request-mic"], ["perm:open-settings", "microphone"],
    ["cua:linux-status"], ["cua:linux-enable"], ["cua:linux-disable"], ["cua:linux-retry"],
    ["computer-use-policy:get"], ["computer-use-policy:set", policy],
    ["approvals:set-trusted-mode", "bot-1", "custom", { source: "settings" }],
  ]);
});

test("screen preview intent uses a synchronous one-shot channel with no renderer payload", () => {
  const before = invocations.length;
  exposed.api.beginScreenPreviewIntent({ sourceId: "arbitrary" });
  assert.deepEqual(invocations.slice(before), [["screen:preview-intent"]]);
});

test("capability updates omit the Electron event and release their listener", () => {
  const calls = [];
  const before = subscriberCount("desktop:capabilities-changed");
  const unsubscribe = exposed.api.onCapabilitiesChanged(value => calls.push(value));
  assert.equal(subscriberCount("desktop:capabilities-changed"), before + 1);
  const capabilities = { localControl: true };
  emit("desktop:capabilities-changed", capabilities);
  assert.deepEqual(calls, [capabilities]);
  unsubscribe();
  assert.equal(subscriberCount("desktop:capabilities-changed"), before);
  emit("desktop:capabilities-changed", {});
  assert.deepEqual(calls, [capabilities]);
});

test("desktop notices use the active state and seen channels", async () => {
  const before = invocations.length;
  await exposed.api.desktopNotices.state();
  await exposed.api.desktopNotices.seen(42);
  assert.deepEqual(invocations.slice(before), [["desktop-notices:state"], ["desktop-notices:seen", "42"]]);
});

test("desktop capabilities are queried without renderer-supplied claims", async () => {
  const before = invocations.length;
  await exposed.api.getCapabilities({ fullControl: true });
  assert.deepEqual(invocations.slice(before), [["desktop:capabilities"]]);
});
