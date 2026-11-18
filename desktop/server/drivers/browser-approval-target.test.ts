import { describe, expect, it } from "vitest";
import { browserApprovalTarget } from "./browser-approval-target.ts";

describe("browser approval target", () => {
  it("keeps the exact temporary origin but never URL secrets or unrelated arguments", () => {
    const target = browserApprovalTarget(true, "agent_browser_open", {
      url: "http://127.0.0.1:43127/private/token?access_token=secret#password",
      password: "hidden",
    });
    expect(target).toEqual({ operation: "open", origin: "http://127.0.0.1:43127" });
    expect(JSON.stringify(target)).not.toMatch(/private|token|secret|password|hidden/);
  });

  it.each([
    "https://user:password@example.com/path",
    "https://user@example.com/path",
    "javascript:alert(1)",
    "file:///private/secret",
    "data:text/plain,secret",
    "/relative?token=secret",
    "not a url",
  ])("omits unsafe or credential-bearing targets: %s", (url) => {
    expect(browserApprovalTarget(true, "agent_browser_open", { url })).toBeUndefined();
  });

  it("does not infer browser identity from another tool or server", () => {
    const args = { url: "https://example.com/?token=secret" };
    expect(browserApprovalTarget(false, "agent_browser_open", args)).toBeUndefined();
    expect(browserApprovalTarget(true, "agent_browser_get_title", args)).toBeUndefined();
    expect(browserApprovalTarget(true, "other_tool", args)).toBeUndefined();
    expect(browserApprovalTarget(true, "agent_browser_open", {})).toBeUndefined();
  });
});
