import { canManage, canReach } from "./peer-roster.ts";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chiefLevel, readTeamRolesWith } from "./chief-level.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { defaultBotPatchRefusal, ensureDefaultBot } from "./default-bot.ts";
import * as mdb from "./message-db.ts";
import { Store, type BotRecord } from "./store.ts";
import { availableTools, catalogProfileFromEnv } from "./drivers/agents-catalog.ts";
import { createBrief } from "./host/brief.ts";
import "./server-line-packs.ts";
import { serverLine, setConversationLanguage } from "./server-lines.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const placeHezuos = (store: Store) => store.bots.filter((bot) => bot.defaultBot && !bot.defaultBot.person);
const intros = (store: Store, bot: BotRecord) => (bot.tasks ?? []).flatMap((task) => store.messagesFor(task.threadId)).filter((message) => message.helperIntro);
const boot = (store: Store) => ensureDefaultBot(store, { dataDir: DATA_DIR });
/** Who the daily brief comes from, as the server picks it. */
const briefChief = (store: Store) => createBrief({ store, dataDir: DATA_DIR, hosted: false, watching: () => true, mainThread: (id) => store.bot(id)?.threadId,
  threadBusy: () => false, notify: () => {}, runs: () => [], needsYou: () => [], engineName: () => "Claude", hostTimeZone: () => "UTC", language: () => undefined, session: () => null,
  address: () => undefined, failRun: () => {}, keep: () => {}, items: () => null }).chief();
/** Historical persisted helper: adoption must not replace its identity or Chief assignment. */
function seededBefore(store: Store): BotRecord {
  const seeded = store.createBot({ name: "Hezuo", color: "silver" });
  store.setChiefOfStaff(seeded.id);
  return seeded;
}

describe("Hezuo, every person's helper", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
  afterEach(() => readTeamRolesWith(() => null));

  it("seeds the default welcome from the store language before conversation services exist", () => {
    setConversationLanguage(() => { throw new ReferenceError("Cannot access routines before initialization"); });
    let language = "zh";
    const store = new Store(selection, undefined, undefined, () => language);
    try {
      store.seedIfEmpty();
      const bot = placeHezuos(store)[0]!;
      expect(intros(store, bot)[0]?.card?.title).toBe(serverLine("zh", "server.helper.hello", { name: bot.name }));
      language = "ko";
      expect(store.greetingLanguage()).toBe("ko");
      expect(boot(store)?.id).toBe(bot.id);
    } finally {
      setConversationLanguage(() => undefined);
    }
  });
  it("adopts a recoloured historical helper without losing the existing Chief", () => {
    const store = new Store(selection);
    const legacy = seededBefore(store);
    store.patchBot(legacy.id, { color: "blue" });
    expect(boot(store)?.id).toBe(legacy.id);
    expect(store.bot(legacy.id)?.chiefOfStaff).toBe(true);
    expect(placeHezuos(store)).toHaveLength(1);
  });

  it("gives a fresh install one Hezuo, its Chief, in chrome, introduced once", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    boot(store);
    boot(store);
    const again = new Store(selection);
    again.seedIfEmpty();
    boot(again);
    expect(again.bots).toHaveLength(1);
    const hezuo = placeHezuos(again)[0]!;
    expect(hezuo).toMatchObject({ name: "Hezuo", color: "chrome", chiefOfStaff: true, defaultBot: {}, pinned: true });
    expect(intros(again, hezuo)).toHaveLength(1);
  });

  it("leaves a Team Cloud member's Hezuo uncrowned: it reaches no bot everyone sees, so a crown would promise work it can't hand on", () => {
    const store = new Store(selection);
    store.seedIfEmpty({ defaultBot: false });
    const own = ensureDefaultBot(store, { dataDir: DATA_DIR, person: "ada@acme.test", team: "Acme" })!;
    expect(own.chiefOfStaff).toBeFalsy();
    const fox = store.createBot({ name: "Fox", reportsTo: "ada@acme.test" } as never);
    expect(canReach(own, fox)).toBe(false);
    expect(canManage(own, fox)).toBe(false);
  });

  it("gives an existing install without one a Hezuo once on update, beside its Chief, which stays exactly as it was", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Pixel" });
    store.setChiefOfStaff(chief.id);
    store.createBot({ name: "Writer", title: "Writer", soul: "Write." });
    const before = structuredClone(store.bot(chief.id));
    const hezuo = boot(store)!;
    expect(hezuo).toMatchObject({ name: "Hezuo", color: "chrome", defaultBot: {} });
    expect(hezuo.chiefOfStaff).toBeFalsy();
    expect(chiefLevel(hezuo)).toBe(true);
    expect(store.bot(chief.id)).toEqual(before);
    expect(intros(store, hezuo)).toHaveLength(1);
    const restarted = new Store(selection);
    boot(restarted);
    expect(placeHezuos(restarted).map((bot) => bot.id)).toEqual([hezuo.id]);
    expect(restarted.bots).toHaveLength(3);
    expect(restarted.bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id)).toEqual([chief.id]);
  });

  it("adopts a new install's renamed Hezuo with its history instead of making another, and puts the intro on top of a new conversation", () => {
    const store = new Store(selection);
    const seeded = seededBefore(store);
    const first = seeded.threadId;
    store.appendMessage(first, { role: "user", kind: "text", text: "Book my flights." });
    store.patchBot(seeded.id, { name: "Jarvis" });
    const history = store.messagesFor(first).map((message) => message.id);
    store.createBot({ name: "Writer" });
    const adopted = boot(store)!;
    expect(adopted.id).toBe(seeded.id);
    expect(adopted).toMatchObject({ name: "Jarvis", color: "chrome", chiefOfStaff: true, defaultBot: {} });
    expect(store.bots).toHaveLength(2);
    expect(history).toHaveLength(2);
    expect(store.messagesFor(first).map((message) => message.id)).toEqual(history);
    expect(adopted.threadId).not.toBe(first);
    expect(store.messagesFor(adopted.threadId).map((message) => message.helperIntro)).toEqual([true]);
    boot(new Store(selection));
    expect(intros(new Store(selection), new Store(selection).bot(seeded.id)!)).toHaveLength(1);
  });

  it("keeps the colour the person gave an adopted Hezuo", () => {
    const store = new Store(selection);
    const seeded = seededBefore(store);
    store.patchBot(seeded.id, { color: "blue" });
    expect(boot(store)).toMatchObject({ id: seeded.id, color: "blue" });
  });

  it("makes Hezuo the Chief of a place that has none, so the brief has someone to come from", () => {
    const store = new Store(selection);
    store.createBot({ name: "Pixel" });
    const hezuo = boot(store)!;
    expect(store.bot(hezuo.id)?.chiefOfStaff).toBe(true);
    expect(briefChief(store)?.id).toBe(hezuo.id);
    expect(intros(store, hezuo)[0]?.text).toContain("Hey! I'm Hezuo. I'm new here. I'm here to be your Chief of Staff. I can manage your other bots.");
  });

  it("makes an adopted Hezuo the Chief when its place has none left", () => {
    const store = new Store(selection);
    const seeded = seededBefore(store);
    store.setChiefOfStaff(null);
    expect(store.bot(seeded.id)?.chiefOfStaff).toBeFalsy();
    expect(boot(store)?.id).toBe(seeded.id);
    expect(store.bot(seeded.id)?.chiefOfStaff).toBe(true);
    expect(briefChief(store)?.id).toBe(seeded.id);
  });

  it("leaves a place's own Chief as the Chief, and the brief comes from Hezuo, which says so", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Clive" });
    store.setChiefOfStaff(chief.id);
    const hezuo = boot(store)!;
    expect(store.bot(hezuo.id)?.chiefOfStaff).toBeFalsy();
    expect(briefChief(store)?.id).toBe(hezuo.id);
    expect(intros(store, hezuo)[0]?.text).toContain("your helper for everything here");
    expect(intros(store, hezuo)[0]?.text).toContain("keep an eye on your day");
    expect(intros(store, hezuo)[0]?.text).not.toContain("Chief of Staff");
  });

  it("keeps a Hezuo Chief hidden from the sidebar working as the Chief", () => {
    const store = new Store(selection);
    const hezuo = boot(store)!;
    store.patchBot(hezuo.id, { sidebarHidden: true });
    const restarted = new Store(selection);
    boot(restarted);
    expect(restarted.bot(hezuo.id)).toMatchObject({ chiefOfStaff: true, sidebarHidden: true });
    expect(briefChief(restarted)?.id).toBe(hezuo.id);
  });

  it("knows a renamed Hezuo by its mark: no second one on update, Chief tools kept", () => {
    const store = new Store(selection);
    store.createBot({ name: "Writer" });
    const chief = store.createBot({ name: "Clive" });
    store.setChiefOfStaff(chief.id);
    const hezuo = boot(store)!;
    store.patchBot(hezuo.id, { name: "Jarvis", color: "blue" });
    const restarted = new Store(selection);
    boot(restarted);
    expect(placeHezuos(restarted).map((bot) => [bot.id, bot.name])).toEqual([[hezuo.id, "Jarvis"]]);
    expect(chiefLevel(restarted.bot(hezuo.id))).toBe(true);
    expect(restarted.bots).toHaveLength(3);
  });

  it("never takes a first bot that is not a new install's Hezuo: it gets a Hezuo beside it", () => {
    const store = new Store(selection);
    const pixel = store.createBot({ name: "Pixel" });
    const hezuo = boot(store)!;
    expect(hezuo.id).not.toBe(pixel.id);
    expect(store.bot(pixel.id)?.defaultBot).toBeUndefined();
  });

  it("introduces itself once: not again after the asks were answered or dismissed, nor after a restart", () => {
    const store = new Store(selection);
    const hezuo = boot(store)!;
    const [intro] = intros(store, hezuo);
    expect(intro?.card?.options).toHaveLength(4);
    store.appendMessage(hezuo.threadId, { role: "user", kind: "text", text: "What can you do?" });
    expect(store.messagesFor(hezuo.threadId).find((message) => message.id === intro!.id)?.card?.dismissed).toBe(true);
    for (let restart = 0; restart < 2; restart++) boot(new Store(selection));
    const after = new Store(selection);
    expect(intros(after, after.bot(hezuo.id)!)).toHaveLength(1);
  });

  it("never counts its intro as something that needs the person", () => {
    const store = new Store(selection);
    const hezuo = boot(store)!;
    expect(intros(store, hezuo)).toHaveLength(1);
    expect(mdb.attentionRows(0).filter((row) => row.kind === "options")).toEqual([]);
  });

  it("is hidden, never deleted or archived, and a hidden Hezuo is never made again", () => {
    const store = new Store(selection);
    const hezuo = boot(store)!;
    const other = store.createBot({ name: "Writer" });
    expect(() => store.deleteBot(hezuo.id)).toThrow(/Hezuo can't be deleted or archived/);
    expect(store.bot(hezuo.id)).toBeTruthy();
    expect(defaultBotPatchRefusal(hezuo, { hidden: true })).toMatch(/Show Hezuo in the sidebar/);
    expect(defaultBotPatchRefusal(other, { sidebarHidden: true })).toMatch(/Only Hezuo/);
    expect(defaultBotPatchRefusal(hezuo, { sidebarHidden: "yes" })).toBe("sidebarHidden must be true or false");
    expect(defaultBotPatchRefusal(hezuo, { sidebarHidden: true })).toBeNull();
    store.patchBot(hezuo.id, { sidebarHidden: true });
    const restarted = new Store(selection);
    boot(restarted);
    expect(placeHezuos(restarted).map((bot) => [bot.id, bot.sidebarHidden])).toEqual([[hezuo.id, true]]);
    restarted.patchBot(hezuo.id, { sidebarHidden: false });
    expect(new Store(selection).bot(hezuo.id)?.sidebarHidden).toBe(false);
  });

  it("is never made twice for one place, even once its mark is gone", () => {
    const store = new Store(selection);
    const hezuo = boot(store)!;
    store.patchBot(hezuo.id, { defaultBot: undefined });
    expect(boot(store)).toBeNull();
    expect(store.bots).toHaveLength(1);
  });

  it("keeps the oldest when two are marked", () => {
    const store = new Store(selection);
    const first = boot(store)!;
    const second = store.createBot({ name: "Hezuo 2" });
    store.patchBot(second.id, { defaultBot: {} });
    expect(boot(store)?.id).toBe(first.id);
    expect(placeHezuos(store).map((bot) => bot.id)).toEqual([first.id]);
  });

  it("gives each Team Cloud member their own private Hezuo, and the team no Hezuo of its own", () => {
    const store = new Store(selection);
    store.seedIfEmpty({ defaultBot: false });
    expect(store.bots).toHaveLength(1);
    expect(store.bots[0]).toMatchObject({ chiefOfStaff: true });
    expect(store.bots[0]?.defaultBot).toBeUndefined();
    const ada = ensureDefaultBot(store, { dataDir: DATA_DIR, person: "Ada@Example.com", team: "Acme" })!;
    const bea = ensureDefaultBot(store, { dataDir: DATA_DIR, person: "bea@example.com", team: "Acme" })!;
    expect(ensureDefaultBot(store, { dataDir: DATA_DIR, person: "ada@example.com", team: "Acme" })?.id).toBe(ada.id);
    expect(ada).toMatchObject({ name: "Hezuo", defaultBot: { person: "ada@example.com" }, visibility: { people: ["ada@example.com"] } });
    expect(bea).toMatchObject({ defaultBot: { person: "bea@example.com" }, visibility: { people: ["bea@example.com"] } });
    expect(ada.chiefOfStaff).toBeFalsy();
    expect(intros(store, ada)[0]?.text).toContain("On Acme, I'm here for you and look after your own bots.");
    expect(intros(store, ada)[0]?.text).not.toContain("keep an eye on your day");
    expect(store.bots).toHaveLength(3);
  });

  it("holds a Chief's tools, never more than its member: a User's Hezuo holds none", () => {
    const store = new Store(selection);
    const place = boot(store)!;
    const member = ensureDefaultBot(store, { dataDir: DATA_DIR, person: "user@example.com", team: "Acme" })!;
    const admin = ensureDefaultBot(store, { dataDir: DATA_DIR, person: "admin@example.com", team: "Acme" })!;
    const tools = (bot: BotRecord) => availableTools(catalogProfileFromEnv({ HEZUO_CHIEF_OF_STAFF: chiefLevel(bot) ? "1" : "0", HEZUO_BOT_ID: bot.id })).map((tool) => tool.name);
    expect(tools(place)).toEqual(expect.arrayContaining(["create_bot", "propose_team_setup", "retry_thread", "manage_room"]));
    expect([chiefLevel(member), chiefLevel(admin)]).toEqual([false, false]);
    readTeamRolesWith((email) => email === "admin@example.com" ? "admin" : email === "user@example.com" ? "member" : null);
    expect([chiefLevel(member), chiefLevel(admin)]).toEqual([false, true]);
    expect(tools(member)).not.toContain("create_bot");
    expect(tools(admin)).toContain("create_bot");
  });
});
