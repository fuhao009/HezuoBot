import { describe, expect, it } from "vitest";

import { allowedScopes, parseAllowList, sessionMember, signInEnabled } from "./session-membership.ts";

describe("the sign-in allow-list", () => {
  it("splits on commas, spaces and newlines and ignores case", () => {
    expect(parseAllowList(" Her@Example.test, @Agentada.test\nstaff@example.test ")).toEqual(["her@example.test", "@agentada.test", "staff@example.test"]);
    expect(parseAllowList(undefined)).toEqual([]);
  });

  it("maps addresses and @domains to scopes, and never matches a look-alike domain", () => {
    const list = { admins: ["her@example.test", "@agentada.test"], members: ["staff@example.test", "@partner.test"] };
    expect(allowedScopes("HER@example.test", list)).toEqual(["admin", "client"]);
    expect(allowedScopes("anyone@agentada.test", list)).toEqual(["admin", "client"]);
    expect(allowedScopes("staff@example.test", list)).toEqual(["client"]);
    expect(allowedScopes("x@partner.test", list)).toEqual(["client"]);
    expect(allowedScopes("x@evilagentada.test", list)).toBeNull();
    expect(allowedScopes("x@agentada.test.evil", list)).toBeNull();
    expect(allowedScopes("@agentada.test", list)).toBeNull();
    expect(allowedScopes("stranger@example.test", list)).toBeNull();
    expect(signInEnabled(list)).toBe(true);
    expect(signInEnabled({ admins: [], members: [] })).toBe(false);
  });
});

describe("team session membership", () => {
  const session = { membershipAuthority: "team" as const, email: "ada@example.test", teamRole: "member" as const, createdAt: 100, memberCheckedAt: 200 };

  it("preserves the member and the last membership check", () => {
    expect(sessionMember(session)).toEqual({ member: { email: session.email, role: "member" }, checkedAt: 200 });
    expect(sessionMember({ ...session, teamRole: "admin" })).toEqual({ member: { email: session.email, role: "admin" }, checkedAt: 200 });
    expect(sessionMember({ ...session, teamRole: "owner" })).toEqual({ member: { email: session.email, role: "owner" }, checkedAt: 200 });
  });

  it("falls back to creation time only when the membership check is absent", () => {
    expect(sessionMember({ ...session, memberCheckedAt: undefined })?.checkedAt).toBe(100);
    expect(sessionMember({ ...session, memberCheckedAt: 0 })?.checkedAt).toBe(0);
  });

  it("rejects sessions without team authority, email or role", () => {
    expect(sessionMember({ ...session, membershipAuthority: undefined })).toBeNull();
    expect(sessionMember({ ...session, email: undefined })).toBeNull();
    expect(sessionMember({ ...session, email: "" })).toBeNull();
    expect(sessionMember({ ...session, teamRole: undefined })).toBeNull();
  });
});
