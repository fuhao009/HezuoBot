import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./AppNotices.tsx", import.meta.url), "utf8");

describe("local app notices", () => {
  it("keeps local guidance and welcome/dialog deferral", () => {
    for (const name of ["SimpleModePrompt", "useHezuoWelcomeDue", "firstReplyPending", "useOtherDialogOpen", "cornerPopupWaits", "markLaunchNotice"]) {
      expect(source).toContain(name);
    }
  });

  it("does not subscribe to upstream marketing or dispatch a purchase flow", () => {
    for (const name of ["WhatsNewPopup", "ProductHunt", "StarCard", "BoatOffer", "CloudTrial", "CloudNotice", "cloudAccount", "openCloudAdd", "UpdatesConsent", "cloudHowTo"]) {
      expect(source).not.toContain(name);
    }
  });

  it("leaves account and onboarding state untouched", () => {
    expect(source).not.toContain("dispatch(");
    expect(source).not.toContain("/api/config");
    expect(source).not.toContain("window.hezuo");
  });
});
