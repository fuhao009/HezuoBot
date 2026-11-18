import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import type * as StoreModule from "@/state/store";
import { SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({ section: "usage" as AppSettingsSection, config: undefined as { cloudHome?: boolean } | undefined, advanced: false }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof StoreModule>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: fixture.section, config: fixture.config }, dispatch: vi.fn() }),
}));
vi.mock("./CloudAccountSettings", () => ({ CloudAccountSettings: () => "RETIRED_CLOUD_PLAN_MARKER" }));
vi.mock("./UsageSection", () => ({ UsageSection: () => "USAGE_DETAILS_MARKER" }));
vi.mock("./PlanUsage", () => ({ PlanUsageSummary: () => "USAGE_SUMMARY_MARKER" }));

const plan = { state: vi.fn(), manage: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "usage";
  fixture.config = undefined;
  setLocale("en");
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });
const render = () => renderToStaticMarkup(createElement(SettingsModal));

// The Cloud account page was retired; a stale bridge must not bring it back.
// Usage remains reachable in both modes, including on a person's Cloud home.
describe.each(["Simple", "Advanced"] as const)("%s Settings with legacy Cloud bridges", (mode) => {
  beforeEach(() => { fixture.advanced = mode === "Advanced"; });
  it.each([
    { name: "a server without a Cloud home", cloudHome: false, local: false },
    { name: "the person's Cloud home", cloudHome: true, local: false },
    { name: "the local desktop account bridge", cloudHome: false, local: true },
  ])("keeps usage available without the retired Cloud page on $name", ({ cloudHome, local }) => {
    vi.stubGlobal("window", { hezuo: { cloudPlan: plan, ...(local ? { cloudAccount: {} } : {}) } });
    fixture.config = { cloudHome };
    const html = render();
    expect(html).toContain("USAGE_DETAILS_MARKER");
    expect(html).not.toContain("RETIRED_CLOUD_PLAN_MARKER");
    expect(html).not.toContain('value="cloudAccount"');
    expect(html).not.toContain('data-settings-section="cloudAccount"');
    expect(html).not.toContain('data-settings-block="cloudAccount"');
    if (fixture.advanced) {
      expect(html).toContain('data-settings-section="usage" aria-current="page"');
      expect(html).toContain('<option value="usage" selected="">');
    } else {
      expect(html).toContain('data-settings-page="billing" aria-current="page"');
      expect(html).toContain('<option value="billing" selected="">');
      expect(html).toContain("Usage &amp; billing");
      expect(html).toContain("USAGE_SUMMARY_MARKER");
      const limits = html.indexOf("See all limits");
      expect(limits).toBeGreaterThan(-1);
      expect(html.indexOf("USAGE_SUMMARY_MARKER")).toBeLessThan(limits);
      expect(html).toMatch(/data-settings-disclosure="billing-limits"[\s\S]*?aria-expanded="false"/);
      expect(html).toMatch(/<div[^>]*hidden=""[^>]*>USAGE_DETAILS_MARKER<\/div>/);
    }
    expect(plan.state).not.toHaveBeenCalled();
    expect(plan.manage).not.toHaveBeenCalled();
  });
});
