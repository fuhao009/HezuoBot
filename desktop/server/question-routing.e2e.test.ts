// Local response routing only. Signed-person inbox copies, delegated answers,
// per-person notifications, and team restart continuity are retired coverage.
import { expect, it } from "vitest";
import { launchCloudSendFixture } from "../../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("routes local question responses through the thread's auth and response validation", async () => {
  const fixture = await launchCloudSendFixture({ onePasswordToken: "ops_fake-local-question-routing" });
  try {
    const created = await fixture.onCloud("POST", "/api/bots", { name: "Question routing" });
    expect(created.status).toBe(201);
    const thread = created.body.bot.threadId;
    const client = await fixture.pairLocal("question routing client", ["client"]);
    const messages = `/api/threads/${thread}/messages`;
    const response = `/api/threads/${thread}/respond`;
    const body = { requestId: "absent-question", behavior: "answer", message: "Yes" };
    expect((await fixture.asSession(client, "GET", messages)).status).toBe(200);
    expect((await fixture.asSession(null, "POST", response, body)).status).toBe(403);
    expect((await fixture.asSession("invalid-session", "POST", response, body)).status).toBe(401);
    const malformed = await fixture.asSession(client, "POST", response, { ...body, behavior: "unknown" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toContain("behavior must be");
    const missing = await fixture.asSession(client, "POST", "/api/threads/absent-thread/respond", body);
    expect(missing.status).toBe(404);
    expect((await fixture.asSession(client, "GET", messages)).status).toBe(200);
  } finally { await fixture.close(); }
}, hostTimeout(90_000));
