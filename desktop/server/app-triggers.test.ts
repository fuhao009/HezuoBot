import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appEventCatalog } from "./app-event-catalog.ts";
import { eventCount } from "./app-events.ts";
import { BrokerError, type AppTriggerBroker, type BrokerEvent, type BrokerInventory, type BrokerTriggerType } from "./app-trigger-broker.ts";
import type { InternalTriggerContext } from "./app-trigger-host.ts";
import { AppTriggerManager, type AppTriggerManagerOptions } from "./app-triggers.ts";
import { RoutineManager } from "./routines.ts";

let dir = "";
let client: AppTriggerBroker;
let instances: Map<string, BrokerInventory["triggers"][number]>;
let events: BrokerEvent[];
let reachable: boolean;
const gmail = "ca_gmail";
const types: BrokerTriggerType[] = [
  { slug: "GMAIL_NEW_GMAIL_MESSAGE", toolkit: "gmail", name: "New Gmail message", description: "An email arrives", type: "poll", config: { properties: { query: { type: "string" } } }, payload: { properties: { sender: { type: "string" }, subject: { type: "string" } } } },
  { slug: "GMAIL_EMAIL_SENT", toolkit: "gmail", name: "Email sent", description: "An email is sent", config: {}, payload: {} },
  { slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", toolkit: "slack", name: "Channel message", description: "A message arrives", config: {}, payload: { properties: { text: { type: "string" } } } },
];

function deliver(triggerId: string | null, data: Record<string, unknown>, id = `event_${events.length + 1}`, kind: BrokerEvent["kind"] = "message") {
  events.push({ seq: events.length + 1, id, kind, triggerId, receivedAt: Date.now(), event: { data } });
}
let routines: RoutineManager;
let connected: Record<string, { connected: boolean; accounts: Array<{ id: string; alias?: string; status: string }> }>;
let failNextEnqueue: "before-save" | "after-save" | null = null;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), "hezuo-app-triggers-"));
  instances = new Map();
  events = [];
  reachable = true;
  let nextId = 0;
  client = {
    triggerTypes: async (apps) => Object.fromEntries(apps.map((app) => [app, { types: types.filter((type) => type.toolkit === app) }])),
    triggerType: async (slug) => {
      if (!reachable) throw new BrokerError("Service could not be reached", 0);
      return types.find((type) => type.slug === slug) ?? null;
    },
    create: async (input) => {
      if (!reachable) throw new BrokerError("Service could not be reached", 0);
      const triggerId = `trigger_${++nextId}`;
      instances.set(triggerId, { triggerId, slug: input.slug, toolkit: types.find((type) => type.slug === input.slug)!.toolkit, connectedAccountId: input.connectedAccountId, enabled: true, remote: { state: "enabled", config: input.config }, dropped: {} });
      return { triggerId };
    },
    setEnabled: async (id, enabled) => {
      const binding = instances.get(id)!;
      binding.enabled = enabled;
      binding.remote = { ...binding.remote, state: enabled ? "enabled" : "disabled" };
    },
    remove: async (id) => { instances.delete(id); },
    inventory: async () => ({ triggers: [...instances.values()], unbound: [], limits: { plan: "desktop", eventsPerDay: 500 }, usage: { eventsToday: events.length } }),
    poll: async ({ after }) => ({ events: events.filter((event) => event.seq > after), cursor: events.length }),
    testEvent: async (id, data) => { deliver(id, data, undefined, "test"); },
  };
  connected = { gmail: { connected: true, accounts: [{ id: gmail, alias: "sales", status: "ACTIVE" }] } };
  // Busy, so runs stay queued: what a burst or a catch-up meets while the bot works on the first one.
  routines = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "busy", createTask: () => ({ threadId: "thread-run" }), startTurn: async () => {} });
  failNextEnqueue = null;
});

afterEach(async () => {
  routines.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function manager(overrides: Partial<AppTriggerManagerOptions> = {}) {
  return new AppTriggerManager({
    file: join(dir, "app-triggers.json"),
    broker: client,
    service: () => ({ available: true }),
    connectedApps: async () => connected,
    botState: () => "ready",
    runs: {
      enqueue: (input) => {
        const failure = failNextEnqueue;
        failNextEnqueue = null;
        if (failure === "before-save") throw new Error("disk full");
        const run = routines.enqueueWebhook(input);
        if (failure === "after-save") throw new Error("crashed after the run was saved");
        return run;
      },
      merge: (triggerId, eventId, merge) => routines.mergeIntoQueuedRun(triggerId, eventId, merge),
      receipt: (triggerId, eventId) => routines.webhookRunReceipt(triggerId, eventId),
      pending: (triggerId) => routines.activeWebhookRunCount(triggerId),
      cancelQueued: (triggerId, message) => routines.cancelQueuedWebhook(triggerId, message),
    },
    log: () => {},
    ...overrides,
  });
}

const runsOf = (triggerId: string) => routines.listRuns().filter((run) => run.routineId === triggerId);
const drain = async (triggers: AppTriggerManager) => { while (await triggers.pollOnce(undefined, 0) > 0) { /* until the queue is empty */ } };

async function gmailTrigger(triggers: AppTriggerManager, filter = { from: "acme.com", subject: "order" }) {
  return triggers.create({ botId: "bot-1", name: "Order replies", prompt: "Draft a reply with the order status.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", filter });
}

describe("AppTriggerManager", () => {
  it("rejects self-hosted app events with 409 without creating an automation", async () => {
    const create = vi.spyOn(client, "create");
    const triggers = manager({ service: () => ({ available: false, reason: "self-hosted" }) });

    await expect(gmailTrigger(triggers)).rejects.toMatchObject({
      status: 409,
      message: "App events need Hezuo's connected apps. This server uses its own Composio key, so it cannot watch apps yet: use a schedule that checks the app, or a webhook.",
    });
    expect(create).not.toHaveBeenCalled();
    expect(instances.size).toBe(0);
    expect(triggers.list()).toEqual([]);
  });

  it("creates the service copy with a Gmail filter folded into Gmail's own search", async () => {
    const triggers = manager();
    const trigger = await gmailTrigger(triggers);
    expect(trigger).toMatchObject({ remote: { state: "active" }, accountId: gmail, accountLabel: "sales", delivery: "poll", eventName: "New Gmail message" });
    expect(instances.get(trigger.remote.triggerId!)?.remote?.config).toEqual({ query: "from:acme.com subject:(order)" });
  });

  it("acks an event only after its run is saved: a failure before the save brings the same event back once", async () => {
    const triggers = manager();
    const trigger = await gmailTrigger(triggers);
    deliver(trigger.remote.triggerId!, { subject: "Order #1042", sender: "j@acme.com" }, "msg_1");
    failNextEnqueue = "before-save";
    await expect(triggers.pollOnce(undefined, 0)).rejects.toThrow("disk full");
    expect(runsOf(trigger.id)).toHaveLength(0);
    await triggers.pollOnce(undefined, 0);
    expect(runsOf(trigger.id)).toHaveLength(1);
    expect(runsOf(trigger.id)[0]).toMatchObject({ triggerSource: "webhook", eventSource: "app", deliveryId: "msg_1" });
    await triggers.pollOnce(undefined, 0);
  });

  it("dedupes a redelivered event: a crash after the run was saved starts no second run", async () => {
    const triggers = manager();
    const trigger = await gmailTrigger(triggers);
    deliver(trigger.remote.triggerId!, { subject: "Order #7" }, "msg_dup");
    failNextEnqueue = "after-save";
    await expect(triggers.pollOnce(undefined, 0)).rejects.toThrow("crashed");
    await triggers.pollOnce(undefined, 0);
    expect(runsOf(trigger.id)).toHaveLength(1);
    expect(eventCount(runsOf(trigger.id)[0]!.prompt)).toBe(1);
    expect(triggers.attempts().map((attempt) => attempt.outcome)).toEqual(["duplicate"]);
    expect(triggers.get(trigger.id)?.received).toBe(0);
  });

  it("turns a burst into at most three runs of up to twenty events, and skips past that", async () => {
    const triggers = manager();
    const trigger = await gmailTrigger(triggers);
    for (let index = 0; index < 50; index += 1) deliver(trigger.remote.triggerId!, { subject: `Order #${index}`, sender: "j@acme.com" });
    await drain(triggers);
    const runs = runsOf(trigger.id);
    expect(runs).toHaveLength(3);
    expect(runs.map((run) => eventCount(run.prompt)).sort((a, b) => a - b)).toEqual([10, 20, 20]);
    for (let index = 0; index < 30; index += 1) deliver(trigger.remote.triggerId!, { subject: `Late #${index}` });
    await drain(triggers);
    expect(runsOf(trigger.id)).toHaveLength(3);
    expect(runsOf(trigger.id).reduce((sum, run) => sum + eventCount(run.prompt), 0)).toBe(60);
    const after = triggers.get(trigger.id)!;
    expect(after.received).toBe(60);
    expect(after.skipped?.tooMany).toBe(20);
    expect(triggers.attempts().filter((attempt) => attempt.outcome === "skipped")).toHaveLength(20);
  });

  it("applies a plain filter to apps that cannot filter at the source", async () => {
    const slack = "ca_slack";
    connected.slack = { connected: true, accounts: [{ id: slack, status: "ACTIVE" }] };
    const triggers = manager();
    const trigger = await triggers.create({ botId: "bot-1", name: "Urgent", prompt: "Tell me.", app: "slack", event: "SLACK_CHANNEL_MESSAGE_RECEIVED", filter: { text: "urgent" } });
    deliver(trigger.remote.triggerId!, { text: "lunch?", user: "ada" });
    deliver(trigger.remote.triggerId!, { text: "URGENT: the site is down", user: "bo" });
    await drain(triggers);
    expect(runsOf(trigger.id)).toHaveLength(1);
    expect(runsOf(trigger.id)[0]!.prompt).toContain("the site is down");
    expect(triggers.get(trigger.id)).toMatchObject({ received: 1, filtered: 1 });
  });

  it("reconciles: a lost copy is made again, one nobody wants is removed, and on/off is matched", async () => {
    const triggers = manager();
    const kept = await gmailTrigger(triggers);
    await client.remove(kept.remote.triggerId!);
    const stray = await client.create({ slug: "GMAIL_NEW_GMAIL_MESSAGE", connectedAccountId: gmail, config: { query: "stray" } });
    await triggers.reconcile();
    const healed = triggers.get(kept.id)!;
    expect(healed.remote).toMatchObject({ state: "active" });
    expect(instances.has(healed.remote.triggerId!)).toBe(true);
    expect(instances.has(stray.triggerId)).toBe(false);
    await client.setEnabled(healed.remote.triggerId!, false);
    await triggers.reconcile();
    expect((await client.inventory()).triggers.find((binding) => binding.triggerId === healed.remote.triggerId)?.enabled).toBe(true);
    await triggers.update(kept.id, { enabled: false });
    expect((await client.inventory()).triggers.find((binding) => binding.triggerId === healed.remote.triggerId)?.enabled).toBe(false);
  });

  it("pauses the automation of a deleted bot, so the app stops sending its events", async () => {
    let gone = false;
    const triggers = manager({ botState: () => (gone ? "missing" : "ready") });
    const trigger = await gmailTrigger(triggers);
    gone = true;
    await triggers.reconcile();
    expect(triggers.get(trigger.id)?.enabled).toBe(false);
    expect((await client.inventory()).triggers.find((binding) => binding.triggerId === trigger.remote.triggerId)?.enabled).toBe(false);
  });

  it("keeps an automation pending while the service is unreachable, and finishes it on its own", async () => {
    reachable = false;
    const triggers = manager();
    await expect(gmailTrigger(triggers)).rejects.toThrow(/could not be reached/);
    reachable = true;
    const trigger = await gmailTrigger(triggers);
    reachable = false;
    await triggers.update(trigger.id, { filter: { from: "globex.com" } }).catch(() => {});
    reachable = true;
    await triggers.reconcile();
    expect(triggers.get(trigger.id)?.remote.state).toBe("active");
  });

  it("shows an expired connection as Reconnect, and clears it once the account works again", async () => {
    const triggers = manager();
    const trigger = await gmailTrigger(triggers);
    deliver(null, { connected_account_id: gmail }, undefined, "account_expired");
    await drain(triggers);
    expect(triggers.get(trigger.id)?.problem?.kind).toBe("reconnect");
    connected.gmail!.accounts[0]!.status = "ACTIVE";
    await triggers.reconcile();
    expect(triggers.get(trigger.id)?.problem).toBeUndefined();
  });


  it("deletes each automation's service copy independently, and Undo restores its settings with a new service ID", async () => {
    const triggers = manager();
    const first = await gmailTrigger(triggers);
    const twin = await triggers.create({ botId: "bot-2", name: "Twin", prompt: "Log it.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", filter: { from: "acme.com", subject: "order" } });
    expect(first.remote.triggerId).toEqual(expect.any(String));
    expect(twin.remote.triggerId).toEqual(expect.any(String));
    expect(twin.remote.triggerId).not.toBe(first.remote.triggerId);
    expect(instances.size).toBe(2);
    await triggers.remove(first.id);
    expect(instances.has(first.remote.triggerId!)).toBe(false);
    expect(instances.has(twin.remote.triggerId!)).toBe(true);
    await triggers.remove(twin.id);
    expect(instances.size).toBe(0);
    const restored = await triggers.restore(twin.id);
    expect(restored).toMatchObject({
      id: twin.id, botId: twin.botId, name: twin.name, prompt: twin.prompt,
      filter: twin.filter, config: twin.config, remote: { state: "active" },
    });
    expect(restored?.remote.triggerId).toEqual(expect.any(String));
    expect(restored?.remote.triggerId).not.toBe(twin.remote.triggerId);
    expect(instances.has(twin.remote.triggerId!)).toBe(false);
    expect(instances.has(restored!.remote.triggerId!)).toBe(true);
    expect(instances.size).toBe(1);
  });
});

describe("appEventCatalog", () => {
  it("lists events only for connected apps the bot may use", async () => {
    const slack = "ca_slack";
    connected.slack = { connected: true, accounts: [{ id: slack, status: "ACTIVE" }] };
    const everything = await appEventCatalog({ broker: client, connected, bot: {} });
    expect(everything.apps.map((app) => app.app)).toEqual(["gmail", "slack"]);
    expect(everything.apps[0]!.events.map((event) => event.event)).toEqual(["GMAIL_NEW_GMAIL_MESSAGE", "GMAIL_EMAIL_SENT"]);
    expect(everything.apps[0]!.events[0]).toMatchObject({ delivery: "poll", filterFields: ["sender", "subject"] });
    const gmailOnly = await appEventCatalog({ broker: client, connected, bot: { connectorTools: { gmail: { tools: "*" } } } });
    expect(gmailOnly.apps.map((app) => app.app)).toEqual(["gmail"]);
    const scoped = await appEventCatalog({ broker: client, connected, bot: { connectorScopes: { apps: { slack: "read" } } } });
    expect(scoped.apps.map((app) => app.app)).toEqual(["slack"]);
    expect((await appEventCatalog({ broker: client, connected, bot: { composio: false } })).apps).toEqual([]);
    expect(everything.notConnected.map((app) => app.app)).not.toContain("gmail");
  });
});

describe("createAppTriggerHost", () => {
  it("refuses an app outside the bot's grants; otherwise applies with one receipt and Undo", async () => {
    const { createAppTriggerHost } = await import("./app-trigger-host.ts");
    const messages = new Map<string, Array<{ id: string; card?: any }>>();
    const bots: Record<string, any> = {
      scout: { id: "scout", name: "Scout", color: "#000" },
      narrow: { id: "narrow", name: "Narrow", color: "#000", connectorTools: { slack: { tools: "*" } } },
    };
    const host = createAppTriggerHost({
      file: join(dir, "host-app-triggers.json"),
      store: {
        bot: (id) => bots[id],
        messagesFor: (threadId) => messages.get(threadId) ?? [],
        appendMessage: (threadId, message) => {
          const line = { id: `m${(messages.get(threadId)?.length ?? 0) + 1}`, ...message };
          messages.set(threadId, [...(messages.get(threadId) ?? []), line]);
          return line;
        },
        patchMessage: (threadId, messageId, patch) => {
          const line = messages.get(threadId)?.find((candidate) => candidate.id === messageId);
          if (line) Object.assign(line, patch);
          return line;
        },
      },
      connectionMode: () => "managed",
      broker: client,
      connectedApps: async () => connected,
      routines: () => routines,
      webhooks: { list: () => [] } as never,
      webhookBase: () => "http://127.0.0.1:8800",
      botState: () => "ready",
      timeZone: () => "UTC",
      visibleBot: () => true,
      emit: () => {},
      audit: () => {},
    });
    const answers: Array<{ status: number; body: any }> = [];
    const json = ((_res: unknown, status: number, body: unknown) => { answers.push({ status, body }); }) as never;
    const operation = { action: "create", trigger: { name: "Acme", instructions: "Draft a reply.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", filter: { from: "acme.com" } } };
    const context = (from: InternalTriggerContext["from"]) => ({ from, threadId: "thread-1", ownsThread: () => true, outsideDriven: () => false, canCommit: () => true });
    await host.submit({} as never, json, { ...context(bots.narrow), operation });
    expect(answers.at(-1)).toMatchObject({ status: 403, body: { error: expect.stringContaining("Narrow has not been given access to Gmail") } });
    expect(host.manager.list()).toEqual([]);
    await host.submit({} as never, json, { ...context(bots.scout), operation });
    expect(answers.at(-1)).toMatchObject({ status: 201, body: { state: "applied", action: "create" } });
    const card = messages.get("thread-1")!.at(-1)!.card;
    expect(card).toMatchObject({ autoApplied: true, answered: "allow", tool: "create_trigger", appTriggerRequest: { operation: { action: "create" } } });
    expect(card.subtitle).toBe("When an email arrives in Gmail (sales) from acme.com (it checks every 15 minutes), Scout follows: Draft a reply.");
    const id = card.appTriggerRequest.resultId as string;
    await host.submit({} as never, json, { ...context(bots.scout), operation: { action: "update", triggerId: id, changes: { filter: { from: "globex.com" } } } });
    const updateCard = messages.get("thread-1")!.at(-1)!.card;
    expect(host.manager.get(id)?.config).toEqual({ query: "from:globex.com" });
    // An event arriving later does not count as a change, so Undo still applies.
    deliver(host.manager.get(id)!.remote.triggerId!, { subject: "Hello" });
    while (await host.manager.pollOnce(undefined, 0) > 0) { /* drain */ }
    expect(await host.undo({ botId: "scout", threadId: "thread-1", requestId: updateCard.requestId })).toMatchObject({ state: "undone", action: "update" });
    expect(host.manager.get(id)).toMatchObject({ filter: { from: "acme.com" }, config: { query: "from:acme.com" } });
    expect(await host.undo({ botId: "scout", threadId: "thread-1", requestId: card.requestId })).toMatchObject({ state: "undone", action: "create" });
    expect(host.manager.list()).toEqual([]);
    expect(instances.size).toBe(0);
  });
});

describe("instructions in the person's words", () => {
  it("tells the bot to write plain actions, and tells each run where its event is", async () => {
    const { TRIGGER_PROMPT } = await import("./system-prompt.ts");
    const { availableTools, catalogProfileFromEnv } = await import("./drivers/agents-catalog.ts");
    const { eventPrompt } = await import("./app-events.ts");
    expect(TRIGGER_PROMPT).toContain('in the plain words the person would use ("draft a reply", "add the lead to the sheet"): never "event data", "payload", "webhook" or "trigger"');
    const create = availableTools(catalogProfileFromEnv({})).find((tool) => tool.name === "trigger")!;
    expect(create.description).toContain("write name and instructions as they would say them");
    expect((create.inputSchema.properties as Record<string, { description?: string }>).instructions!.description)
      .toContain("in the person's plain words (\"draft a reply\"), never \"event data\", \"payload\", \"webhook\" or \"trigger\"");
    expect(eventPrompt("Draft a reply.", "[UNTRUSTED APP EVENT DATA]\n{}\n[/UNTRUSTED APP EVENT DATA]"))
      .toContain("The email, message or record these instructions mean is in the UNTRUSTED APP EVENT DATA below.");
  });
});
