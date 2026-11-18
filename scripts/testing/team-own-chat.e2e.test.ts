// Retained local authorization coverage; not signed Cloud Team/private-chat coverage.
// The public pairing route exchanges local codes only. It does not accept signed
// member/team identity, so own-chat isolation and member continuity are retired here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "./cloud-send-fixture.ts";

console.info("team-own-chat: signed Cloud Team coverage retired; running local session authorization only (no member identity/private-chat claim).");

describe("local paired sessions (not retired Team own-chat)", () => {
  let fixture: CloudSendFixture | undefined;
  let client = "";
  beforeAll(async () => {
    fixture = await launchCloudSendFixture({ onePasswordToken: "ops_fake-local-auth" });
    client = await fixture.pairLocal("local client", ["client"]);
  }, 60_000);
  afterAll(async () => { await fixture?.close(); });

  it("pairs a genuine client code without inventing team identity", async () => {
    const session = await fixture!.asSession(client, "GET", "/api/auth/session");
    expect(session.status).toBe(200);
    expect(session.body.scopes).toEqual(["client"]);
    expect(session.body.teamRole).toBeUndefined();
    expect(session.body.membershipAuthority).toBeUndefined();
    expect((await fixture!.asSession(client, "GET", "/api/bots")).status).toBe(200);
  });

  it("refuses anonymous proxy access and invalid credentials without loopback fallback", async () => {
    const anonymous = await fixture!.asSession(null, "GET", "/api/bots");
    expect(anonymous.status).toBe(403);
    expect(anonymous.body.error).toContain("came through a proxy");
    const invalid = await fixture!.asSession("not-a-session", "GET", "/api/bots");
    expect(invalid.status).toBe(401);
    expect(invalid.body.error).toContain("expired or was revoked");
  });

  it("does not let a client mint an admin code or list/revoke sessions", async () => {
    expect((await fixture!.asSession(client, "POST", "/api/auth/pairing", { scopes: ["admin", "client"] })).status).toBe(403);
    expect((await fixture!.asSession(client, "GET", "/api/auth/sessions")).status).toBe(403);
    expect((await fixture!.asSession(client, "DELETE", "/api/auth/sessions/not-a-session")).status).toBe(403);
    expect((await fixture!.onCloud("GET", "/api/auth/sessions")).status).toBe(200);
  });

  it("revocation removes access rather than falling back to loopback trust", async () => {
    const token = await fixture!.pairLocal("revoked local client", ["client"]);
    const session = await fixture!.asSession(token, "GET", "/api/auth/session");
    expect(session.status).toBe(200);
    expect(typeof session.body.id).toBe("string");
    expect((await fixture!.onCloud("DELETE", `/api/auth/sessions/${session.body.id}`)).status).toBe(200);
    expect((await fixture!.asSession(token, "GET", "/api/bots")).status).toBe(401);
  });
});
