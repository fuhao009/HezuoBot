import { expect, it } from "vitest";
import { launchCloudSendFixture } from "../../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("keeps a locally paired client's server alive after request-sized threadIds arrays", async () => {
  const fixture = await launchCloudSendFixture({ onePasswordToken: "synthetic-route-guard-token" });
  try {
    const client = await fixture.pairLocal("route guards", ["client"]);
    for (const refs of [{ threadIds: Array<string>(200_000).fill("") }, { envelope: { threadIds: Array<string>(200_000).fill("") } }]) {
      const body = { memberIds: [], ...refs };
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(1_000_000);
      expect((await fixture.asSession(client, "GET", "/api/bots")).status).toBe(200);
      const response = await fixture.asSession(client, "POST", "/api/groups", body);
      expect(response.status, fixture.logs()).toBe(400);
      expect((await fixture.asSession(client, "GET", "/api/bots")).status).toBe(200);
    }
  } finally {
    await fixture.close();
  }
}, hostTimeout(120_000));
