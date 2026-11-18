// Signed Team Cloud browser verification is retired: local pairing supplies scopes,
// not verified member identity, bot audiences or per-member private conversations.
// Run this retained local authorization smoke with:
// node --experimental-strip-types scripts/verify-team-bot-access.ts
import assert from "node:assert/strict";
import { launchCloudSendFixture } from "./testing/cloud-send-fixture.ts";

console.info("RETIRED: signed Cloud Team role/audience UI verification is unavailable. This command verifies local session authorization only; it produces no Team screenshots or legacy coverage claim.");
if (process.argv.includes("--shots") || process.argv.includes("--only")) {
  throw new Error("Team screenshot verification is retired; --shots/--only have no supported local equivalent. Run without those flags for local authorization verification.");
}
const fixture = await launchCloudSendFixture({ onePasswordToken: "ops_fake-local-bot-access" });
try {
  const client = await fixture.pairLocal("local bot access client", ["client"]);
  const session = await fixture.asSession(client, "GET", "/api/auth/session");
  assert.equal(session.status, 200);
  assert.deepEqual(session.body.scopes, ["client"]);
  assert.equal(session.body.teamRole, undefined);
  assert.equal((await fixture.asSession(client, "GET", "/api/bots")).status, 200);
  const anonymous = await fixture.asSession(null, "GET", "/api/bots");
  assert.equal(anonymous.status, 403);
  assert.match(anonymous.body.error, /came through a proxy/);
  const invalid = await fixture.asSession("invalid-session", "GET", "/api/bots");
  assert.equal(invalid.status, 401);
  assert.match(invalid.body.error, /expired or was revoked/);
  assert.equal((await fixture.asSession(client, "POST", "/api/auth/pairing", { scopes: ["admin", "client"] })).status, 403);
  assert.equal((await fixture.asSession(client, "GET", "/api/auth/sessions")).status, 403);
  assert.equal((await fixture.onCloud("GET", "/api/auth/sessions")).status, 200);
  assert.equal((await fixture.onCloud("DELETE", `/api/auth/sessions/${session.body.id}`)).status, 200);
  assert.equal((await fixture.asSession(client, "GET", "/api/bots")).status, 401);
  console.info("PASS: local client pairing/read, unauthenticated denial, admin-scope denial, and session revocation. No signed Team Cloud coverage.");
} finally {
  await fixture.close();
}
