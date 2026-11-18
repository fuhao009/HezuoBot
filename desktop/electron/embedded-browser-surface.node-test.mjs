import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createEmbeddedBrowserSurfaceManager, embeddedBrowserPartition } from "./embedded-browser-surface.mjs";

function fixture() {
  const windows = [];
  const closed = [];
  const children = [];
  const created = [];
  const owner = { isDestroyed: () => false, getContentSize: () => [1000, 800], webContents: { getZoomFactor: () => 2 },
    contentView: { addChildView(view) { children.push(view); }, removeChildView(view) { const index = children.indexOf(view); if (index >= 0) children.splice(index, 1); } } };
  const manager = createEmbeddedBrowserSurfaceManager({ owner,
    createFallbackWindow(title) {
      const window = new EventEmitter();
      const attached = [];
      Object.assign(window, { title, attached, contentView: { addChildView: view => attached.push(view), removeChildView: view => { const index = attached.indexOf(view); if (index >= 0) attached.splice(index, 1); } },
        isDestroyed: () => false, getContentSize: () => [1100, 780],
        show() { this.visible = true; }, hide() { this.visible = false; }, focus() { this.focused = true; }, destroy() { this.destroyed = true; } });
      windows.push(window);
      return window;
    }, onFallbackClose: binding => closed.push(binding),
    createNativeView(options) {
    const contents = new EventEmitter();
    Object.assign(contents, { isDestroyed: () => false, isFocused: () => false, focus() { this.focused = true; },
      loadURL: async () => {}, setWindowOpenHandler(handler) { this.openHandler = handler; }, close() { this.emit("destroyed"); } });
    const view = { options, webContents: contents, setBounds(bounds) { this.bounds = bounds; }, getBounds() { return this.bounds; },
      setVisible(value) { this.visible = value; }, setBackgroundColor(value) { this.background = value; } };
    created.push(view); return view;
  } });
  return { manager, created, children, windows, closed };
}

test("model view stays visible behind a separate input shield until the exact server grant", async () => {
  const { manager, created } = fixture();
  const view = await manager.createView({ profileKey: "a", session: {}, viewport: { width: 1280, height: 800 } });
  const binding = { surfaceId: "one", revision: 1, accountKey: "account", profileKey: "a" };
  manager.attach(binding);
  manager.layout({ ...binding, bounds: { x: 10, y: 20, width: 100, height: 200 }, visible: true });
  assert.equal(view.visible, true);
  assert.deepEqual(view.bounds, { x: 20, y: 40, width: 200, height: 400 });
  const shield = created[1];
  assert.equal(shield.visible, true);
  assert.equal(shield.background, "#00000000");
  manager.setInteractive({ ...binding, revision: 0 }, true);
  assert.equal(shield.visible, true);
  manager.setInteractive(binding, true);
  assert.equal(shield.visible, false);
  manager.focus(binding);
  assert.equal(view.webContents.focused, true);
  manager.setHidden(binding, true);
  manager.layout({ ...binding, bounds: { x: 10, y: 20, width: 100, height: 200 }, visible: true });
  assert.equal(view.visible, false);
  assert.equal(shield.visible, false);
  manager.setHidden(binding, false);
  assert.equal(view.visible, true);
  assert.equal(shield.visible, true);
  manager.detach(binding);
  assert.equal(view.visible, false);
  await manager.closeAll();
});

test("takeover reuses the authorized page, focuses one window and closes without losing the page", async () => {
  const { manager, windows, closed } = fixture();
  const view = await manager.createView({ profileKey: "bot-a", session: {} });
  let destroyed = false;
  view.webContents.on("destroyed", () => { destroyed = true; });
  const binding = { surfaceId: "one", revision: 1, accountKey: "account", profileKey: "bot-a", interactive: true };
  assert.equal(manager.takeover(binding, "A’s browser"), true);
  assert.equal(manager.takeover(binding, "A’s browser"), true);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].focused, true);
  assert.equal(windows[0].title, "A’s browser");
  assert.equal(view.visible, true);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1100, height: 780 });
  let prevented = false;
  windows[0].emit("close", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(view.visible, false);
  assert.equal(destroyed, false);
  assert.deepEqual(closed, [binding]);
  await manager.closeAll();
});

test("different bots keep independent windows and denied authority opens none", async () => {
  const { manager, windows } = fixture();
  const a = await manager.createView({ profileKey: "a", session: {} });
  const b = await manager.createView({ profileKey: "b", session: {} });
  const binding = { surfaceId: "a", revision: 1, profileKey: "a", interactive: true };
  assert.equal(manager.takeover({ ...binding, interactive: false }, "Denied"), false);
  assert.equal(manager.takeover({ ...binding, hidden: true }, "Hidden"), false);
  assert.equal(windows.length, 0);
  manager.takeover(binding, "A");
  manager.takeover({ ...binding, surfaceId: "b", profileKey: "b" }, "B");
  assert.equal(windows.length, 2);
  assert.equal(a.visible, true);
  assert.equal(b.visible, true);
  manager.closeTakeover(binding);
  assert.equal(a.visible, false);
  assert.equal(b.visible, true);
  await manager.closeAll();
});

test("stale surface operations cannot affect a replacement profile", async () => {
  const { manager } = fixture();
  const first = await manager.createView({ profileKey: "a", session: {} });
  const second = await manager.createView({ profileKey: "b", session: {} });
  const old = { surfaceId: "old", revision: 1, accountKey: "account", profileKey: "a" };
  const next = { ...old, surfaceId: "new", revision: 2, profileKey: "b" };
  manager.attach(old); manager.attach(next);
  manager.layout({ ...next, bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true });
  manager.detach(old); manager.setInteractive(old, true);
  assert.equal(first.visible, false); assert.equal(second.visible, true);
  await manager.closeAll();
});

test("browser partitions separate product accounts and profiles", () => {
  assert.notEqual(embeddedBrowserPartition("a", "p"), embeddedBrowserPartition("b", "p"));
  assert.notEqual(embeddedBrowserPartition("a", "p"), embeddedBrowserPartition("a", "q"));
  assert.equal(embeddedBrowserPartition("a", "p"), embeddedBrowserPartition("a", "p"));
});

test("revoking authority hides an independent window without closing its page", async () => {
  const { manager, windows, closed } = fixture();
  const view = await manager.createView({ profileKey: "private", session: {} });
  let destroyed = false;
  view.webContents.on("destroyed", () => { destroyed = true; });
  const binding = { surfaceId: "private", revision: 1, profileKey: "private", interactive: true };
  manager.takeover(binding, "Private");
  manager.updateTakeover({ ...binding, hidden: true, interactive: false });
  assert.equal(view.visible, false);
  assert.equal(windows[0].visible, false);
  assert.equal(destroyed, false);
  assert.equal(closed.length, 1);
  await manager.closeAll();
});
