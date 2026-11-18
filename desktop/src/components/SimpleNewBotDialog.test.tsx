// @vitest-environment happy-dom
import { setTimeout as delay } from "node:timers/promises";
import { SimpleNewBotDialog } from "./SimpleNewBotDialog";
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { BotCreationDraft } from "@/lib/bot-creation-draft";
import { EMPTY_BOT_DEFAULTS } from "@/lib/bot-creation-draft";
import { useBotEditor } from "./bot-settings/BotEditorContext";

const fx = vi.hoisted(() => ({ dispatch: vi.fn(), create: vi.fn(), load: vi.fn(), close: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { bots: [] }, dispatch: fx.dispatch }),
  BotEditorStore: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/lib/new-bot", () => ({
  newBotDraft: (...args: unknown[]) => fx.load(...args),
  makeNewBot: (...args: unknown[]) => fx.create(...args),
  validNewBotProfile: (bot: Bot) => Boolean(bot.name.trim()) && new TextEncoder().encode(bot.soul).length <= 24000,
}));
vi.mock("./BotProfileAvatarCard", () => ({ BotProfileAvatarCard: ({ onPatch, allowGeneration = true }: { onPatch: (patch: Partial<Bot>) => void; allowGeneration?: boolean }) => {
  const editor = useBotEditor();
  return createElement("div", null,
    allowGeneration && createElement("div", { "data-avatar-generation": true }, "Image provider / API key / Generate avatar"),
    createElement("button", { "data-avatar": true, onClick: () => onPatch({ color: "blue", mascotBody: "cursor" }) }, "avatar"),
    createElement("button", { "data-avatar-upload": true, onClick: async () => {
      const avatarUrl = await editor.uploadAvatar!(new File(["image"], "avatar.png", { type: "image/png" }));
      onPatch({ avatarUrl, avatarCrop: "circle" });
    } }, "upload"));
} }));

let host: HTMLDivElement;
let root: Root;
let draft: BotCreationDraft;
const action = { type: "newBot" as const, onCreated: vi.fn(), onError: vi.fn() };
const settle = () => delay(0);
const button = () => host.querySelector<HTMLButtonElement>("[data-new-bot-create]")!;
async function mount() {
  flushSync(() => root.render(createElement(SimpleNewBotDialog, { action, onClose: fx.close })));
  await settle();
}
function type(selector: string, value: string) {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  fx.load.mockImplementation(async (_section: unknown, _bots: unknown, changed: () => void) => {
    draft = new BotCreationDraft({ ...EMPTY_BOT_DEFAULTS, profile: { name: "Pixel 2" } }, changed);
    return draft;
  });
  fx.create.mockResolvedValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("simple new Bot dialog", () => {
  it("shows only avatar, prefilled name, optional prompt and creation/cancel controls", async () => {
    await mount();
    expect(host.querySelector("[role=dialog]")).not.toBeNull();
    expect(host.querySelectorAll("input")).toHaveLength(1);
    expect(host.querySelectorAll("textarea")).toHaveLength(1);
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("Pixel 2");
    expect(host.querySelector("[data-avatar]")).not.toBeNull();
    expect(host.querySelectorAll("select")).toHaveLength(0);
    expect(host.querySelector("[data-avatar-generation]")).toBeNull();
    expect(button().disabled).toBe(false);
    expect(fx.create).not.toHaveBeenCalled();
  });
  it("cancels without creating a Bot", async () => {
    await mount();
    flushSync(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "common.cancel")!.click());
    expect(fx.close).toHaveBeenCalledOnce();
    expect(fx.create).not.toHaveBeenCalled();
  });
  it("disables creation for blank names and prompts over the UTF-8 byte limit", async () => {
    await mount();
    type("input", "  ");
    expect(button().disabled).toBe(true);
    type("input", "Writer");
    type("textarea", "中".repeat(8000));
    expect(button().disabled).toBe(false);
    type("textarea", "中".repeat(8000) + "a");
    expect(button().disabled).toBe(true);
    expect(host.querySelector("textarea")!.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("newBot.promptTooLong");
    type("textarea", "");
    expect(button().disabled).toBe(false);
  });
  it("submits the chosen avatar, name and soul with existing callbacks and closes on success", async () => {
    await mount();
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-avatar]")!.click());
    type("input", "Writer");
    type("textarea", "Answer in Chinese.");
    flushSync(() => button().click());
    await settle();
    expect(fx.create).toHaveBeenCalledOnce();
    expect(fx.create.mock.calls[0][0]).toMatchObject({ onCreated: action.onCreated, onError: expect.any(Function) });
    expect(fx.create.mock.calls[0][5].bot).toMatchObject({ name: "Writer", soul: "Answer in Chinese.", color: "blue" });
    expect(fx.close).toHaveBeenCalledOnce();
  });
  it("retains the draft and reports errors without closing when creation fails", async () => {
    fx.create.mockImplementation(async (options: { onError: (message: string) => void }) => { options.onError("offline"); return false; });
    await mount();
    flushSync(() => button().click());
    await settle();
    expect(fx.close).not.toHaveBeenCalled();
    expect(action.onError).toHaveBeenCalledWith("offline");
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("offline");
    expect(button().disabled).toBe(false);
  });
  it("creates the default avatar and prefilled name with an empty prompt", async () => {
    await mount();
    flushSync(() => button().click());
    await settle();
    expect(fx.create.mock.calls[0][5].bot).toMatchObject({ name: "Pixel 2", color: "green", soul: "" });
    expect(fx.load).toHaveBeenCalledOnce();
    expect(fx.close).toHaveBeenCalledOnce();
  });
  it("keeps uploaded images in the draft until creation and releases previews on cancel", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:new-bot-avatar");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      await mount();
      flushSync(() => host.querySelector<HTMLButtonElement>("[data-avatar-upload]")!.click());
      await settle();
      expect(createUrl).toHaveBeenCalledOnce();
      expect(draft.bot).toMatchObject({ avatarUrl: "blob:new-bot-avatar", avatarCrop: "circle" });
      expect(fx.create).not.toHaveBeenCalled();
      flushSync(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "common.cancel")!.click());
      flushSync(() => root.render(null));
      expect(revokeUrl).toHaveBeenCalledWith("blob:new-bot-avatar");
      expect(fx.create).not.toHaveBeenCalled();
    } finally { createUrl.mockRestore(); revokeUrl.mockRestore(); }
  });
  it("prevents duplicate creation and cancellation while saving", async () => {
    const { promise, resolve: finish } = Promise.withResolvers<boolean>();
    fx.create.mockReturnValue(promise);
    await mount();
    flushSync(() => { button().click(); button().click(); });
    expect(fx.create).toHaveBeenCalledOnce();
    expect(button().disabled).toBe(true);
    expect(host.querySelector("fieldset")!.disabled).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "common.cancel")!.disabled).toBe(true);
    host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(fx.close).not.toHaveBeenCalled();
    expect(fx.dispatch).toHaveBeenCalledWith({ type: "botCreationPending", on: true });
    finish(true);
    await settle();
    expect(fx.dispatch).toHaveBeenCalledWith({ type: "botCreationPending", on: false });
    expect(fx.close).toHaveBeenCalledOnce();
  });
  it("disposes a draft that finishes loading after cancellation without creating", async () => {
    const { promise, resolve: finish } = Promise.withResolvers<BotCreationDraft>();
    fx.load.mockReturnValue(promise);
    await mount();
    expect(button().disabled).toBe(true);
    flushSync(() => root.render(null));
    const abandoned = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn());
    const dispose = vi.spyOn(abandoned, "dispose");
    finish(abandoned);
    await settle();
    expect(dispose).toHaveBeenCalledOnce();
    expect(fx.create).not.toHaveBeenCalled();
  });
});
