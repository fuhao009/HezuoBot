import { expect, it } from "vitest";
import { launchCloudSendFixture } from "../../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("lets a locally paired client read a real thread before and after unauthenticated protocol requests are refused", async () => {
  const fixture = await launchCloudSendFixture({ onePasswordToken: "synthetic-protocol-auth-token" });
  try {
    const client = await fixture.pairLocal("protocol reader", ["client"]);
    const created = await fixture.onCloud("POST", "/api/bots", { name: "Support" });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const path = `/api/threads/${bot.mainThreadId}/messages?limit=200`;
    expect((await fixture.asSession(client, "GET", path)).status).toBe(200);
    for (const [token, status] of [[null, 403], ["hezuo_not-a-session", 401]] as const) {
      expect((await fixture.asSession(token, "GET", path)).status).toBe(status);
      for (const route of [`/api/bots/${bot.id}/messages`, `/api/bots/${bot.id}/messages/guarded`]) {
        expect((await fixture.asSession(token, "POST", route, { text: "forged request", threadId: bot.mainThreadId })).status).toBe(status);
      }
      expect((await fixture.asSession(client, "GET", path)).status).toBe(200);
    }
  } finally {
    await fixture.close();
  }
}, hostTimeout(120_000));
