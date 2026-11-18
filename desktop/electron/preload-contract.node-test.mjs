import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const localOrigin = "http://127.0.0.1:43123";
const remoteOrigin = "https://server.example.test";

function loadBridge({ origin = localOrigin, flags = [], active = false } = {}) {
  let exposed;
  const calls = [];
  const electron = {
    ipcRenderer: {
      on: () => undefined,
      removeListener: () => undefined,
      invoke: async (...args) => { calls.push(args); },
      send: (...args) => { calls.push(args); },
      sendSync: (...args) => { calls.push(args); return null; },
    },
    contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api }; } },
    webUtils: { getPathForFile: () => "" },
  };
  runInNewContext(source, {
    require: (name) => { assert.equal(name, "electron"); return electron; },
    process: { platform: process.platform, argv: [`--hezuo-local-origin=${localOrigin}`, ...flags] },
    location: { origin },
    navigator: { userActivation: { isActive: active } },
    queueMicrotask,
  }, { filename: "preload.cjs" });
  return { ...exposed, calls };
}

const remoteSafe = [
  "platform", "app", "getCapabilities", "onCapabilitiesChanged", "applySkin", "setUnreadCount",
  "permStatus", "workspaces", "desktopNotices", "desktopAnalytics", "desktopLanguage",
  "windowControls", "onOpenAppSettings", "windowFrame",
];

test("the local workspace exposes the active native desktop APIs without raw IPC", () => {
  const { name, api } = loadBridge();
  assert.equal(name, "hezuo");
  assert.equal(api.app.ownPage, true);
  for (const path of [
    "getCapabilities", "permStatus", "permRequestMic", "permOpenSettings", "beginScreenPreviewIntent",
    "screenFrame", "approvals.setMode", "computerUsePolicy.get", "computerUsePolicy.set",
    "localControl.status", "localControl.enable", "localControl.disable", "localControl.retry",
    "androidDevice.status", "androidDevice.frame", "androidDevice.input", "copyText", "openLogsFolder",
    "talkShortcut.state", "talkShortcut.set", "callActive", "onOpenAppSettings",
  ]) {
    assert.equal(typeof path.split(".").reduce((value, key) => value?.[key], api), "function", path);
  }
  for (const key of ["ipcRenderer", "require", "process", "invoke", "send", "sendSync"]) {
    assert.equal(key in api, false, key);
  }
});

test("remote pages receive exactly the safe bridge even with managed desktop flags", () => {
  const { api } = loadBridge({ origin: remoteOrigin, flags: ["--hezuo-company-desktop=1", "--hezuo-product-managed=1"] });
  assert.equal(api.app.ownPage, false);
  assert.deepEqual(Object.keys(api).sort(), [...remoteSafe].sort());
  assert.equal(typeof api.desktopAnalytics.enabled, "function");
  assert.equal("set" in api.desktopAnalytics, false);
});

test("managed account and organisation APIs require the local desktop flags", () => {
  const plain = loadBridge().api;
  assert.equal(plain.productAccount, undefined);
  assert.equal(plain.organization, undefined);
  const managed = loadBridge({ flags: ["--hezuo-company-desktop=1", "--hezuo-product-managed=1"] }).api;
  assert.equal(typeof managed.productAccount.state, "function");
  assert.equal(typeof managed.organization.state, "function");
});

test("remote workspace and window-frame changes require an active user gesture", async () => {
  const blocked = loadBridge({ origin: remoteOrigin });
  await assert.rejects(blocked.api.workspaces.add("address", "https://other.example.test"), /Choose what to add/);
  await assert.rejects(blocked.api.windowFrame.set(true), /Choose to turn the window frame/);
  assert.deepEqual(blocked.calls, []);
  const allowed = loadBridge({ origin: remoteOrigin, active: true });
  await allowed.api.workspaces.add("address", "https://other.example.test");
  await allowed.api.windowFrame.set(true);
  assert.deepEqual(allowed.calls, [["workspaces:add", "address", "https://other.example.test"], ["window-frame:set", true]]);
  await assert.rejects(allowed.api.workspaces.add("arbitrary", "https://other.example.test"), /Choose a server link or address/);
  assert.equal(allowed.calls.length, 2);
});

test("the static remote allowlist matches the runtime security boundary", () => {
  const match = /\bconst\s+REMOTE_SAFE\s*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]\s*\)/s.exec(source);
  assert.ok(match, "REMOTE_SAFE must remain an explicit allowlist");
  const keys = [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
  assert.deepEqual(keys.sort(), [...remoteSafe].sort());
  assert.match(source, /\bconst\s+remoteKeys\s*=\s*REMOTE_SAFE\s*;/);
});
