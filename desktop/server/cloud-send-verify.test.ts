import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loginFingerprints } from "./cloud-send-verify.ts";
import { LoginStore } from "./login-store.ts";
import { parseTotpKey } from "./totp.ts";

// Obvious fakes only.
const PASSWORD = "fake-verify-Passw0rd";
const NONCE = "x".repeat(43);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const store = () => { const dir = mkdtempSync(join(tmpdir(), "hezuo-verify-")); dirs.push(dir); return new LoginStore({ dataDir: dir }); };

describe("credential fingerprints a move checks by", () => {
  it("are equal for the same login and token saved on two servers, and change with the secret or the nonce", () => {
    const totp = parseTotpKey("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP")!;
    const [here, there] = [store(), store()];
    for (const side of [here, there]) {
      side.create({ site: "example.test", hosts: ["accounts.example.test"], exactHost: false, username: "alice", password: PASSWORD, totp, source: "settings", bots: "all" });
      side.setOnePasswordToken("ops_fake-verify");
    }
    expect(loginFingerprints(NONCE, there)).toEqual(loginFingerprints(NONCE, here));
    expect(Object.keys(loginFingerprints(NONCE, here)).sort()).toEqual(["1password", "login:example.test|alice"]);
    const login = there.list()[0]!;
    there.update(login.id, { password: `${PASSWORD}-2` });
    expect(loginFingerprints(NONCE, there)["login:example.test|alice"]).not.toBe(loginFingerprints(NONCE, here)["login:example.test|alice"]);
    expect(loginFingerprints("y".repeat(43), here)["login:example.test|alice"]).not.toBe(loginFingerprints(NONCE, here)["login:example.test|alice"]);
    const other = store();
    other.create({ site: "example.test", hosts: ["accounts.example.test"], exactHost: false, username: "alice", password: PASSWORD, totp: parseTotpKey("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ")!, source: "settings", bots: "all" });
    expect(loginFingerprints(NONCE, other)["login:example.test|alice"], "another 2FA key is another login").not.toBe(loginFingerprints(NONCE, here)["login:example.test|alice"]);
    expect(JSON.stringify(loginFingerprints(NONCE, here))).not.toContain(PASSWORD);
  });

});
