// Retained direct question-card protocol. Retired signed-person inbox routing,
// chief-of-staff copies and per-person notifications are not covered by local sessions.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchCloudSendFixture } from "../../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("a local session answers a real ask_user choice card and the bot carries on", async () => {
  const fixture = await launchCloudSendFixture({
    onePasswordToken: "ops_fake-local-question-card",
    cloudEngine: 'process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/room-plan.json";',
  });
  try {
    const made = await fixture.onCloud("POST", "/api/bots", { name: "Question card" });
    expect(made.status).toBe(201);
    const bot = made.body.bot;
    expect((await fixture.onCloud("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", applyToAllThreads: true })).status).toBe(200);
    writeFileSync(join(fixture.root, "cloud", "room-plan.json"), JSON.stringify({
      [bot.id]: { script: [{ key: "LOCAL-QUESTION", match: ["LOCAL-QUESTION-JOB"], timeoutMs: 120_000,
        steps: [{ server: "hezuo", tool: "ask_user", arguments: { question: "Apply the footer fix?", choices: ["Yes", "No"] }, capture: { answer: "([\\s\\S]+)" } }],
        reply: "LOCAL-QUESTION-DONE: {{answer}}" }] },
    }));
    const client = await fixture.pairLocal("question client", ["client"]);
    const opened = await fixture.asSession(client, "POST", `/api/bots/${bot.id}/tasks`, { title: "Local question" });
    expect(opened.status).toBe(201);
    const thread = opened.body.task.threadId;
    expect((await fixture.asSession(client, "POST", `/api/bots/${bot.id}/messages`, { text: "LOCAL-QUESTION-JOB", threadId: thread })).status).toBe(202);
    let requestId = "";
    // The server and simulated engine run in child processes; wait on observed card state.
    await expect.poll(async () => {
      const result = await fixture.asSession(client, "GET", `/api/threads/${thread}/messages`);
      expect(result.status).toBe(200);
      const rows = result.body.messages as Array<{ card?: { requestId?: string; requestType?: string; subtitle?: string; options?: string[] } }>;
      const card = rows.find((row) => row.card?.subtitle === "Apply the footer fix?")?.card;
      if (card) {
        expect(card.requestType).toBe("question");
        expect(card.options).toEqual(["Yes", "No"]);
        requestId = card.requestId ?? "";
      }
      return requestId;
    }, { timeout: 90_000 }).not.toBe("");
    expect((await fixture.asSession(client, "POST", `/api/threads/${thread}/respond`, { requestId, behavior: "answer", message: "Yes" })).status).toBe(200);
    await expect.poll(async () => {
      const result = await fixture.asSession(client, "GET", `/api/threads/${thread}/messages`);
      const rows = result.body.messages as Array<{ text?: string; card?: { requestId?: string; answered?: string } }>;
      const completed = rows.some((row) => row.text?.includes("LOCAL-QUESTION-DONE"));
      return completed && Boolean(rows.find((row) => row.card?.requestId === requestId)?.card?.answered);
    }, { timeout: 60_000 }).toBe(true);
  } finally { await fixture.close(); }
}, hostTimeout(240_000));
