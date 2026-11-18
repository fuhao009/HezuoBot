// @vitest-environment happy-dom
// The Simple bot panel in a real DOM, where effects run and focus moves: named links, Escape and focus, and the chat
// header's pill that opens it.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotSettingsSection } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), settingsOpen: false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: () => Promise.resolve(null),
    useStore: () => ({ state: { ...original.initialState, settingsOpen: fixture.settingsOpen }, dispatch: fixture.dispatch, flushBotPatches: () => Promise.resolve(null) }),
  };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("../DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("../DesktopCapabilities")>(),
  useCaptionChrome: () => ({ dragProps: {}, padClass: "" }),
}));
vi.mock("../Avatar", () => ({ BotAvatar: () => null, HezuoAvatar: () => null }));
vi.mock("../AvatarImageGenerator", () => ({ AvatarImageGenerator: () => null }));
vi.mock("@/lib/use-organization-branding", () => ({ useOrganizationBranding: () => null }));
vi.mock("./pages", () => ({
  PageBody: ({ page, editingInstructions }: { page: string; editingInstructions?: boolean }) =>
    createElement("div", { "data-stub-page": page, "data-editing-instructions": editingInstructions === true ? "true" : undefined },
      createElement("section", { "data-panel-card": "approval" })),
  pageSurfaceCls: "",
}));

const { BotPanel } = await import("./PanelShell");
const { openBotSettings } = await import("./panel-link");
const { ChatHeadPill } = await import("../ChatHeadPill");

const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};
const onClose = vi.fn();
const patch = vi.fn();
const derived = { activeState: "idle", patch, approvalMode: "ask" } as never;

let host: HTMLDivElement;
let root: Root;
// The panel sits inside BotSettingsDialog's <aside role="dialog">, as it does in the app.
const render = (linkedSection: BotSettingsSection | null) =>
  flushSync(() => root.render(createElement("aside", { role: "dialog" }, createElement(BotPanel, { bot, derived, linkedSection, onClose }))));
// Passive effects and the renders they schedule.
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const page = () => host.querySelector("[data-panel-page-view]")?.getAttribute("data-panel-page-view") ?? null;
const prompt = () => host.querySelector("[data-panel-prompt]");
const instructions = () => host.querySelector<HTMLTextAreaElement>("[data-panel-prompt] textarea");
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const press = (element: Element | null, key: string) => {
  if (!element) throw new Error("nothing to press");
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  flushSync(() => element.dispatchEvent(event));
  return event;
};
// What BotSettingsDialog's window listener would do with the key: close the whole panel.
const dialogCloses = vi.fn();
const onWindowKey = (event: KeyboardEvent) => {
  if (event.key === "Escape" && !event.defaultPrevented) dialogCloses();
};

beforeEach(() => {
  fixture.dispatch.mockReset();
  onClose.mockReset();
  patch.mockReset();
  dialogCloses.mockReset();
  window.addEventListener("keydown", onWindowKey);
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  window.removeEventListener("keydown", onWindowKey);
  flushSync(() => root.unmount());
  host.remove();
  // A link without a page lands where its section does, so no test sees another's page.
  openBotSettings(vi.fn(), "overview");
});

describe("named links into the bot panel", () => {
  it("opens on the page a link names, and moves there when a link arrives while it is open", async () => {
    openBotSettings(fixture.dispatch, "access", { page: "apps" });
    render("access");
    await settle();
    expect(page()).toBe("apps");

    flushSync(() => openBotSettings(fixture.dispatch, "access", { page: "folder" }));
    await settle();
    expect(page()).toBe("folder");

    // Simple mode has no MCP page: the link lands where Access does.
    flushSync(() => openBotSettings(fixture.dispatch, "access", { page: "mcp" }));
    await settle();
    expect(page()).toBeNull();
    expect(prompt()).not.toBeNull();

    flushSync(() => openBotSettings(fixture.dispatch, "access", { page: "apps" }));
    await settle();
    expect(page()).toBe("apps");

    flushSync(() => openBotSettings(fixture.dispatch, "access"));
    await settle();
    expect(page()).toBeNull();
    expect(prompt()).not.toBeNull();
  });

  it("follows the same link again after the panel has moved on", async () => {
    openBotSettings(fixture.dispatch, "skills");
    render("skills");
    await settle();
    expect(page()).toBe("skills");

    click(host.querySelector("[data-panel-back]"));
    expect(page()).toBeNull();

    flushSync(() => openBotSettings(fixture.dispatch, "skills"));
    render("skills");
    await settle();
    expect(page()).toBe("skills");
  });

  it("opens Bot settings with the Instructions editor for a soul link, and closes it when the panel moves on", async () => {
    openBotSettings(fixture.dispatch, "soul");
    render("soul");
    await settle();
    expect(page()).toBe("settings");
    expect(host.querySelector('[data-stub-page="settings"]')?.getAttribute("data-editing-instructions")).toBe("true");
    click(host.querySelector("[data-panel-back]"));
    expect(page()).toBeNull();
    flushSync(() => openBotSettings(fixture.dispatch, "permissions"));
    render("permissions");
    await settle();
    expect(page()).toBe("settings");
    expect(host.querySelector('[data-stub-page="settings"]')?.getAttribute("data-editing-instructions")).toBeNull();
  });

  it("scrolls a permissions link to Before it acts on the Bot settings page", async () => {
    const scrolled = vi.mocked(HTMLElement.prototype.scrollIntoView);
    openBotSettings(fixture.dispatch, "permissions");
    render("permissions");
    await settle();
    expect(page()).toBe("settings");
    expect(scrolled.mock.contexts).toContain(host.querySelector('[data-panel-card="approval"]'));
  });

  it("lands usage, history, voice, visibility and access links on the first screen, with no page of their own", async () => {
    for (const section of ["usage", "history", "voice", "visibility", "overview", "access"] as const) {
      openBotSettings(fixture.dispatch, section);
      render(section);
      await settle();
      expect(page(), section).toBeNull();
      expect(prompt(), section).not.toBeNull();
    }
  });
});

describe("the panel's first screen", () => {
  it("has the bot's instructions under the hero, and no tabs", async () => {
    render(null);
    await settle();
    expect(host.querySelector("[data-panel-avatar]")!.compareDocumentPosition(prompt()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const field = instructions()!;
    expect(prompt()!.querySelector("label")!.textContent).toBe("Instructions");
    expect(prompt()!.querySelector("label")!.getAttribute("for")).toBe(field.id);
    expect(field.placeholder).toBe("How should Scout work? What should it always or never do?");
    expect(host.querySelector('[role="tablist"], [role="tab"], [data-panel-tab]')).toBeNull();
  });

  it("asks under the instructions whether the bot checks before it acts, and saves the choice for every conversation", async () => {
    render(null);
    await settle();
    const acts = host.querySelector("[data-panel-acts]")!;
    expect(prompt()!.compareDocumentPosition(acts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...acts.querySelectorAll("[data-approval-choice]")].map((choice) => [choice.textContent, choice.getAttribute("aria-pressed")]))
      .toEqual([["Ask me first", "true"], ["Just do it", "false"]]);
    click(acts.querySelector('[data-approval-choice="full"]'));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateBot", botId: "scout", patch: { approvalMode: "full", applyToAllThreads: true } });
  });

  it("saves what is typed into the instructions", async () => {
    render(null);
    await settle();
    const field = instructions()!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Be brief.");
    flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
    expect(patch).toHaveBeenCalledWith({ soul: "Be brief." });
    expect(instructions()!.value).toBe("Be brief.");
  });

  it("gives way to a linked page, and returns when Back is pressed", async () => {
    openBotSettings(fixture.dispatch, "skills");
    render("skills");
    await settle();
    expect(prompt()).toBeNull();
    click(host.querySelector("[data-panel-back]"));
    expect(prompt()).not.toBeNull();
  });
});

describe("the panel's top", () => {
  it("has Close alone, with no Share menu and no gear", async () => {
    render(null);
    await settle();
    const first = host.querySelector("button")!;
    expect(first.getAttribute("aria-label")).toBe("Close settings");
    expect(first.querySelector("svg")).not.toBeNull();
    expect(first.parentElement!.querySelectorAll("button")).toHaveLength(1);
    expect(host.querySelector("[data-panel-share], [data-panel-gear]")).toBeNull();
    click(first);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("puts the name right under the avatar, with no call button beside it", async () => {
    render(null);
    await settle();
    const row = host.querySelector("[data-panel-name-row]")!;
    expect(row.querySelector("[data-panel-rename]")!.textContent).toBe("Scout");
    expect(host.querySelector("[data-panel-avatar]")!.nextElementSibling).toBe(row);
    expect(host.querySelector("[data-call-button]")).toBeNull();
  });
});

describe("the chat header's pill", () => {
  const withTasks: Bot = { ...bot, tasks: [
    { threadId: "thread-scout", title: "Plan the launch", createdAt: 1 },
    { threadId: "other", title: "Older notes", createdAt: 0, unread: true },
  ] };
  const pill = (props: Partial<Parameters<typeof ChatHeadPill>[0]> = {}) => {
    const header = document.createElement("div");
    document.body.append(header);
    const headerRoot = createRoot(header);
    const onToggle = vi.fn();
    flushSync(() => headerRoot.render(createElement(ChatHeadPill, { bot: withTasks, avatar: { state: "idle" }, privacy: null, onToggle, ...props })));
    return { header, onToggle, done: () => { flushSync(() => headerRoot.unmount()); header.remove(); } };
  };

  it("names the bot, opens the bot panel, and dots another conversation that needs a look", () => {
    const { header, onToggle, done } = pill();
    try {
      const button = header.querySelector<HTMLButtonElement>("[data-chathead-pill]")!;
      expect(button.textContent).toBe("Scout");
      expect(button.getAttribute("aria-label")).toBe("Open Scout's profile");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.hasAttribute("aria-controls")).toBe(false);
      expect(header.querySelector("[data-chathead-chevron]")).not.toBeNull();
      expect(header.querySelector("[data-chathead-elsewhere]")!.getAttribute("aria-label")).toBe("Other activity (1)");
      click(button);
      expect(onToggle).toHaveBeenCalledOnce();
    } finally {
      done();
    }
  });

  it("says the panel is open and points at it, then hides the hover chevron", () => {
    fixture.settingsOpen = true;
    const { header, done } = pill();
    try {
      const button = header.querySelector<HTMLButtonElement>("[data-chathead-pill]")!;
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(button.getAttribute("aria-controls")).toBe("bot-panel");
      expect(header.querySelector("[data-chathead-chevron]")).toBeNull();
    } finally {
      fixture.settingsOpen = false;
      done();
    }
  });

  it("names the conversation on screen when it is not the bot's main one", () => {
    const { header, done } = pill({ bot: { ...withTasks, mainThreadId: "other" } });
    try {
      const button = header.querySelector<HTMLButtonElement>("[data-chathead-pill]")!;
      expect(header.querySelector("[data-chathead-conversation]")!.textContent).toBe("Plan the launch");
      expect(button.getAttribute("aria-label")).toBe("Open Scout's profile, Plan the launch");
      expect(header.querySelector("[data-chathead-chevron]")).toBeNull();
    } finally {
      done();
    }
    const untitled = pill({ bot: { ...withTasks, mainThreadId: "other", tasks: [{ ...withTasks.tasks![0]!, title: "New thread" }, withTasks.tasks![1]!] } });
    try {
      expect(untitled.header.querySelector("[data-chathead-conversation]")!.textContent).toBe("New conversation");
    } finally {
      untitled.done();
    }
  });

  it("has no dot when the other conversations are quiet, and says who can read a team chat", () => {
    const quiet = pill({ bot: { ...withTasks, tasks: withTasks.tasks!.map((task) => ({ ...task, unread: false })) }, privacy: { kind: "private" } });
    try {
      expect(quiet.header.querySelector("[data-chathead-elsewhere]")).toBeNull();
      expect(quiet.header.querySelector('[data-chathead-privacy="private"]')!.textContent).toBe("Private · only you");
    } finally {
      quiet.done();
    }
  });
});

describe("Escape in the bot panel", () => {
  const onPage = async () => {
    openBotSettings(fixture.dispatch, "skills");
    render("skills");
    await settle();
    expect(page()).toBe("skills");
  };

  it("goes back from a drill-in page instead of closing the panel, though the panel sits in a dialog", async () => {
    await onPage();
    const back = host.querySelector<HTMLElement>("[data-panel-back]");
    back?.focus();
    const event = press(back, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(page()).toBeNull();
    expect(dialogCloses).not.toHaveBeenCalled();
    // On the first screen, Escape is the dialog's: it closes the panel.
    press(instructions(), "Escape");
    expect(dialogCloses).toHaveBeenCalledTimes(1);
  });
});

describe("focus around the hero", () => {
  const avatar = () => host.querySelector<HTMLElement>("[data-panel-avatar]");
  const card = () => host.querySelector("[data-panel-avatar-editor]");

  it("moves focus into the avatar editor, and back to the avatar however it closes", async () => {
    render(null);
    await settle();
    avatar()!.focus();
    click(avatar());
    await settle();
    expect(card()).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-avatar-tab")).toBe("bot");

    const event = press(document.activeElement, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(avatar());
    expect(dialogCloses).not.toHaveBeenCalled();

    click(avatar());
    await settle();
    click(host.querySelector("[data-panel-scrim]"));
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(avatar());
    // Focus is back where Escape is heard: the next one is the dialog's.
    press(document.activeElement, "Escape");
    expect(dialogCloses).toHaveBeenCalledTimes(1);
  });

  it.each([["data-panel-rename", "Enter"], ["data-panel-rename", "Escape"], ["data-panel-label", "Enter"], ["data-panel-label", "Escape"]])(
    "gives focus back to the %s button after %s, so the next Escape still works",
    async (attr, key) => {
      render(null);
      await settle();
      click(host.querySelector(`[${attr}]`));
      const input = host.querySelector<HTMLInputElement>(`[${attr}-input]`);
      expect(document.activeElement).toBe(input);
      press(input, key);
      await settle();
      expect(host.querySelector(`[${attr}-input]`)).toBeNull();
      expect(document.activeElement).toBe(host.querySelector(`[${attr}]`));
      expect(dialogCloses).not.toHaveBeenCalled();
      press(document.activeElement, "Escape");
      expect(dialogCloses).toHaveBeenCalledTimes(1);
    },
  );
});
