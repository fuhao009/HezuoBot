import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComposerAttachments from "./composer-attachments";

const fixture = vi.hoisted(() => ({ track: vi.fn(), openBot: vi.fn(), uploadImage: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));
vi.mock("@/state/thread-navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/thread-navigation")>(), openBot: fixture.openBot,
}));
vi.mock("./composer-attachments", async (importOriginal) => ({
  ...await importOriginal<typeof ComposerAttachments>(), imageAttachmentFromFile: fixture.uploadImage,
}));

import type { Action, Bot } from "@/state/store";
import { BotCreationDraft } from "./bot-creation-draft";
import { setTeamChats } from "@/state/team-chats";
import { setTeamPeople, type TeamPeople } from "@/state/team-people";
import { makeNewBot, newBotDraft, validNewBotProfile, type BotDefaultsAnswer } from "./new-bot";

const ME = { email: "ada@acme.test", name: "Ada", role: "member", you: true as const };
const BOB = { email: "bob@acme.test", name: "Bob", role: "admin" };
const team: TeamPeople = { people: [ME, BOB], me: ME, admin: false, needsYou: [] };

function server(answer: Partial<BotDefaultsAnswer> = {}, fail?: { on: "POST" | "PATCH"; error: string }) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let bot: Bot | null = null;
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method, path, body });
    if (path === "/api/bot-defaults") {
      return { defaults: { profile: {}, memory: {}, skills: [], routines: [] }, modelSelection: { instanceId: "claude", model: "sonnet" }, suggestedName: "Pixel", ...answer };
    }
    if (fail?.on === method) throw new Error(fail.error);
    if (path === "/api/bots" && method === "POST") {
      bot = { id: "created", threadId: "created-main", name: body.name, title: "", description: "", soul: "", color: "green", notifications: true,
        unread: false, messages: [], section: body.section, modelSelection: body.modelSelection ?? { instanceId: "", model: "" } } as Bot;
      return { bot };
    }
    if (path === "/api/bots/created" && method === "PATCH") { bot = { ...bot!, ...body }; return { bot }; }
    return {};
  });
  return { calls, request: request as never, created: () => calls.find((call) => call.method === "POST" && call.path === "/api/bots")?.body };
}

async function newBot(request: never, action: Partial<Extract<Action, { type: "newBot" }>> = {}, bots: Bot[] = []) {
  const dispatch = vi.fn<(action: Action) => void>();
  await makeNewBot({ type: "newBot", ...action }, bots, dispatch, false, request);
  return dispatch.mock.calls.map(([sent]) => sent);
}

beforeEach(() => { fixture.track.mockReset(); fixture.openBot.mockReset(); fixture.uploadImage.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); setTeamPeople(null); setTeamChats(null); });

describe("New bot", () => {
  it("creates from reviewed defaults and selects the new chat", async () => {
    const { calls, request, created } = server();
    const sent = await newBot(request);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /api/bot-defaults", "POST /api/bots", "PATCH /api/bots/created"]);
    expect(created()).toMatchObject({ name: "Pixel", modelSelection: { instanceId: "claude", model: "sonnet" }, requireAvailableModel: true, useDefaults: false });
    expect(created()).not.toHaveProperty("reportsTo");
    expect(sent).toEqual([{ type: "botAdded", bot: expect.objectContaining({ id: "created", name: "Pixel" }), preserveSelection: false }]);
    expect(fixture.track.mock.calls).toEqual([["bot_created", { source: "blank" }]]);
  });

  it("names the bot so it never repeats one already here", async () => {
    const taken = [{ name: "Helper" }, { name: "helper 2" }] as Bot[];
    const named = server({ defaults: { profile: { name: "Helper" }, memory: {}, skills: [], routines: [] } });
    await newBot(named.request, {}, taken);
    expect(named.created()).toMatchObject({ name: "Helper 3" });
  });

  it("with no AI set up, still makes the bot, without one, for the first AI connected later", async () => {
    const { calls, request, created } = server({ modelSelection: { instanceId: "", model: "" } });
    const sent = await newBot(request);
    expect(created()).not.toHaveProperty("modelSelection");
    expect(created()).not.toHaveProperty("requireAvailableModel");
    expect(calls.find((call) => call.method === "PATCH")!.body).not.toHaveProperty("modelSelection");
    expect(sent.map((action) => action.type)).toEqual(["botAdded"]);
  });

  it("on a team, makes it in this place, reporting to the department's person or else to its creator, in their own chat", async () => {
    setTeamPeople(team);
    setTeamChats({ teamId: "acme", member: true, opened: [] });
    const sales = [{ id: "closer", name: "Closer", section: "Sales", reportsTo: BOB.email }] as Bot[];
    const inSales = server();
    const sent = await newBot(inSales.request, { section: "Sales" }, sales);
    expect(inSales.created()).toMatchObject({ section: "Sales", reportsTo: BOB.email });
    expect(sent[0]).toMatchObject({ type: "botAdded", preserveSelection: false });
    expect(fixture.openBot).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ id: "created" }), false);
    const general = server();
    await newBot(general.request, {}, sales);
    expect(general.created()).toMatchObject({ reportsTo: ME.email });
  });

  it("keeps a department dialog where it is", async () => {
    setTeamChats({ teamId: "acme", member: true, opened: [] });
    const onCreated = vi.fn();
    const sent = await newBot(server().request, { section: "Sales", preserveSelection: true, onCreated });
    expect(sent).toEqual([expect.objectContaining({ type: "botAdded", preserveSelection: true })]);
    expect(fixture.openBot).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "created" }));
  });

  it.each(["POST", "PATCH"] as const)("a failure (%s) shows one plain error and leaves no bot behind", async (on) => {
    const { calls, request } = server({}, { on, error: "this workspace is limited to 200 bots" });
    const sent = await newBot(request);
    expect(sent).toEqual([{ type: "error", message: "Couldn't make a new bot: this workspace is limited to 200 bots" }]);
    if (on === "PATCH") expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/bots/created" });
    expect(fixture.track).not.toHaveBeenCalled();
    const onError = vi.fn();
    expect(await newBot(server({}, { on, error: "offline" }).request, { onError })).toEqual([]);
    expect(onError).toHaveBeenCalledWith("Couldn't make a new bot: offline");
  });

  it("starts a bot whose defaults say Auto on this computer on Ask, and says so", async () => {
    const { calls, request } = server({ defaults: { profile: { approvalMode: "auto", computer: "local" }, memory: {}, skills: [], routines: [] } });
    const sent = await newBot(request);
    expect(calls.find((call) => call.method === "PATCH")!.body).toMatchObject({ approvalMode: "ask" });
    expect(sent.at(-1)).toEqual({ type: "notice", notice: { kind: "note", botName: null,
      text: "Pixel will ask before acting. To let it act on this computer by itself, choose Approve for me in its settings." } });
  });

  it("from a paired device, sends one request and leaves the defaults to the host", async () => {
    vi.stubGlobal("window", { hezuo: { remoteClient: { active: true } } });
    const { calls, request } = server();
    const sent = await newBot(request, { section: "Sales" });
    expect(calls).toEqual([{ method: "POST", path: "/api/bots", body: { section: "Sales" } }]);
    expect(sent.map((action) => action.type)).toEqual(["botAdded"]);
  });

  it("loads a unique prefilled draft without creating anything", async () => {
    const { calls, request } = server();
    const draft = await newBotDraft("Sales", [{ name: "pixel" }, { name: "Pixel 2" }] as Bot[], vi.fn(), request);
    expect(draft.bot).toMatchObject({ name: "Pixel 3", section: "Sales", color: "green", soul: "" });
    expect(calls.map(call => call.path)).toEqual(["/api/bot-defaults"]);
    draft.dispose();
    expect(calls).toHaveLength(1);
  });

  it("creates the chosen avatar and optional standing instructions while retaining other defaults", async () => {
    const { calls, request } = server({ defaults: { profile: { title: "Research", notifications: false, browser: true }, memory: {}, skills: [], routines: [] } });
    const draft = await newBotDraft(undefined, [], vi.fn(), request);
    draft.patch({ name: "  Writer  ", soul: "只用中文回答。", color: "blue", mascotBody: "cursor", avatarUrl: "/api/attachments/avatar.png", avatarCrop: "circle" });
    const dispatch = vi.fn();
    const onCreated = vi.fn();
    expect(await makeNewBot({ type: "newBot", onCreated }, [], dispatch, false, request, draft)).toBe(true);
    expect(calls.filter(call => call.path === "/api/bot-defaults")).toHaveLength(1);
    expect(calls.find(call => call.method === "PATCH")?.body).toMatchObject({ name: "Writer", title: "Research", notifications: false, browser: true,
      soul: "只用中文回答。", color: "blue", mascotBody: "cursor", avatarUrl: "/api/attachments/avatar.png", avatarCrop: "circle" });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "botAdded", preserveSelection: false }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: "Writer", soul: "只用中文回答。" }));
    draft.dispose();
  });

  it.each(["", " ", "\n"])("rejects blank names (%j) before creating", async name => {
    const { calls, request } = server();
    const draft = await newBotDraft(undefined, [], vi.fn(), request);
    draft.patch({ name });
    expect(validNewBotProfile(draft.bot)).toBe(false);
    expect(await makeNewBot({ type: "newBot", onError: vi.fn() }, [], vi.fn(), false, request, draft)).toBe(false);
    expect(calls).toHaveLength(1);
    draft.dispose();
  });

  it("counts multibyte prompts in UTF-8, allowing exactly 24,000 bytes and rejecting one byte more", async () => {
    const { calls, request } = server();
    const draft = await newBotDraft(undefined, [], vi.fn(), request);
    draft.patch({ soul: "中".repeat(8000) });
    expect(validNewBotProfile(draft.bot)).toBe(true);
    draft.patch({ soul: draft.bot.soul + "a" });
    expect(validNewBotProfile(draft.bot)).toBe(false);
    expect(await makeNewBot({ type: "newBot", onError: vi.fn() }, [], vi.fn(), false, request, draft)).toBe(false);
    expect(calls).toHaveLength(1);
    draft.patch({ soul: "" });
    expect(validNewBotProfile(draft.bot)).toBe(true);
    draft.dispose();
  });

  it("stores an uploaded avatar before creation and announces the persisted image", async () => {
    const { calls, request } = server();
    const draft = await newBotDraft(undefined, [], vi.fn(), request);
    const avatar = new File(["image"], "avatar.png", { type: "image/png" });
    draft.avatarFile = avatar;
    draft.patch({ avatarUrl: "blob:avatar-preview", avatarCrop: "circle" });
    fixture.uploadImage.mockResolvedValue({ path: "/private/attachments/uploaded-avatar.png" });
    const dispatch = vi.fn();
    const onCreated = vi.fn();
    expect(await makeNewBot({ type: "newBot", onCreated }, [], dispatch, false, request, draft)).toBe(true);
    expect(fixture.uploadImage).toHaveBeenCalledWith(avatar);
    expect(calls.find(call => call.method === "PATCH")?.body).toMatchObject({ avatarUrl: "/api/attachments/uploaded-avatar.png", avatarCrop: "circle" });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "botAdded", bot: expect.objectContaining({ avatarUrl: "/api/attachments/uploaded-avatar.png" }), preserveSelection: false }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: "/api/attachments/uploaded-avatar.png" }));
    draft.dispose();
  });

  it("does not create a bot if an uploaded avatar cannot be stored", async () => {
    const { calls, request } = server();
    const draft = await newBotDraft(undefined, [], vi.fn(), request);
    draft.avatarFile = new File(["image"], "avatar.png", { type: "image/png" });
    draft.patch({ avatarUrl: "blob:avatar-preview" });
    fixture.uploadImage.mockRejectedValue(new Error("upload unavailable"));
    const onError = vi.fn();
    const dispatch = vi.fn();
    expect(await makeNewBot({ type: "newBot", onError }, [], dispatch, false, request, draft)).toBe(false);
    expect(onError).toHaveBeenCalledWith("Couldn't make a new bot: upload unavailable");
    expect(calls).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(draft.bot.avatarUrl).toBe("blob:avatar-preview");
    draft.dispose();
  });

  it("does not turn a completed creation into a retry when its callback throws", async () => {
    const { calls, request } = server();
    const dispatch = vi.fn();
    const onCreated = vi.fn(() => { throw new Error("callback failed"); });
    expect(await makeNewBot({ type: "newBot", onCreated }, [], dispatch, false, request)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "botAdded", preserveSelection: false }));
    expect(dispatch).toHaveBeenCalledWith({ type: "error", message: "callback failed" });
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
    expect(calls.some(call => call.method === "DELETE")).toBe(false);
  });

  it("disposes an internally loaded draft when its saved prompt exceeds the limit", async () => {
    const { calls, request } = server({ defaults: { profile: { soul: "中".repeat(8001) }, memory: {}, skills: [], routines: [] } });
    const dispose = vi.spyOn(BotCreationDraft.prototype, "dispose");
    try {
      const onError = vi.fn();
      expect(await makeNewBot({ type: "newBot", onError }, [], vi.fn(), false, request)).toBe(false);
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("24,000 UTF-8 bytes"));
      expect(dispose).toHaveBeenCalledOnce();
      expect(calls).toHaveLength(1);
    } finally { dispose.mockRestore(); }
  });
});
