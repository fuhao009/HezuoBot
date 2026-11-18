// @vitest-environment happy-dom
// The Room panel in a real DOM, where effects run and focus moves: its instructions and Escape.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, ConfigStatus, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), config: null as ConfigStatus | null }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, bots: fixtureBots, config: fixture.config } as AppState, dispatch: fixture.dispatch }),
  };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("../DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("../DesktopCapabilities")>(),
  useCaptionChrome: () => ({ dragProps: {}, padClass: "" }),
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: "/Users/ada" } }, ready: true }),
}));
vi.mock("../Avatar", () => ({ BotAvatar: () => null, HezuoAvatar: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const bot = (id: string, name: string): Bot => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
});
const fixtureBots = [bot("lead", "Desk Manager"), bot("bench", "Vendor Bench"), bot("paper", "Paperwork"), bot("match", "Matcher")];

const { RoomPanel } = await import("./RoomPanel");
const { closeRoomPanel, openRoomPanel, useRoomPanel } = await import("@/lib/room-panel");

const room = (patch: Partial<Group> = {}): Group => ({
  id: "desk", threadId: "desk-thread", name: "Desk HQ", description: "The recruiting desk", memberIds: fixtureBots.map((b) => b.id),
  defaultResponder: { kind: "member", botId: "lead" }, bulletin: "Hand out the work here.\nKeep it short.",
  unread: false, createdAt: 1, setupCompletedAt: 1, messages: [],
  ...patch,
});
const jev = (enabled: boolean) => ({ rooms: { turnTimeoutMinutes: 5 }, decider: { provider: "jev", configured: enabled, enabled, jobs: { roomRouting: true } } } as ConfigStatus);

let host: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;
const seen = { open: null as string | null };
function Probe() {
  seen.open = useRoomPanel();
  return null;
}
const render = (group: Group) => flushSync(() => root.render([
  createElement(RoomPanel, { key: "panel", group }),
  createElement(Probe, { key: "probe" }),
]));
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T & HTMLElement>(selector);
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const press = (element: Element | null, key: string, init: KeyboardEventInit = {}) => {
  if (!element) throw new Error("nothing to press");
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  flushSync(() => element.dispatchEvent(event));
  return event;
};
const type = (field: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
};
const patches = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "patchGroup");

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.config = jev(true);
  document.documentElement.dataset.reducedMotion = "true";
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  opener = document.createElement("button");
  document.body.append(opener);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => openRoomPanel("desk", opener));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  opener.remove();
  closeRoomPanel();
  document.body.innerHTML = "";
});

describe("the Room panel's card", () => {
  it("shows the room's faces, name and description, then its instructions and nothing else", () => {
    render(room());
    expect($("#room-panel-title")?.textContent).toBe("Desk HQ");
    expect($("[data-room-panel]")?.textContent).toContain("The recruiting desk");
    expect($('[data-panel-edit="instructions"]')?.textContent).toContain("Hand out the work here.");
    expect($('[data-panel-edit="instructions"]')?.textContent).not.toContain("Keep it short.");
    for (const gone of ['[data-panel-page="responder"]', '[data-panel-page="folder"]', '[data-panel-row="members"]', '[data-testid="room-more"]']) expect($(gone), gone).toBeNull();
  });

  it("asks for instructions while the room has none", () => {
    render(room({ bulletin: "" }));
    expect($('[data-panel-edit="instructions"]')?.textContent).toContain("Tell the bots what this room is for");
  });
});

describe("Instructions", () => {
  const field = () => $<HTMLTextAreaElement>('[data-panel-row="instructions"] textarea');

  it("edits in place and saves once with Done", async () => {
    render(room());
    click($('[data-panel-edit="instructions"]'));
    expect(field()?.value).toBe("Hand out the work here.\nKeep it short.");
    type(field()!, "Hand out the work here.");
    click($('[data-panel-done="instructions"]'));
    await settle();
    expect(field()).toBeNull();
    expect(patches()).toEqual([{ type: "patchGroup", groupId: "desk", patch: { bulletin: "Hand out the work here." } }]);
    expect(document.activeElement?.getAttribute("data-panel-edit")).toBe("instructions");
  });

  it("saves on ⌘↩ and on blur", async () => {
    render(room());
    click($('[data-panel-edit="instructions"]'));
    type(field()!, "New brief");
    press(field(), "Enter", { metaKey: true });
    await settle();
    expect(field()).toBeNull();
    click($('[data-panel-edit="instructions"]'));
    type(field()!, "Blurred brief");
    flushSync(() => field()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(patches().map((action) => action.patch)).toEqual([{ bulletin: "New brief" }, { bulletin: "Blurred brief" }]);
  });

  it("drops the draft on Escape and keeps the panel open", async () => {
    render(room());
    click($('[data-panel-edit="instructions"]'));
    type(field()!, "Never mind");
    const escape = press(field(), "Escape");
    await settle();
    expect(escape.defaultPrevented).toBe(true);
    expect(field()).toBeNull();
    expect(patches()).toEqual([]);
    expect(seen.open).toBe("desk");
  });
});

describe("Escape", () => {
  it("closes the panel and hands focus back to the room's name", async () => {
    render(room());
    await settle();
    press($("[data-room-panel]"), "Escape");
    await settle();
    expect(seen.open).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes from the ✕ too", () => {
    render(room());
    click($('[aria-label="Close settings"]'));
    expect(seen.open).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
