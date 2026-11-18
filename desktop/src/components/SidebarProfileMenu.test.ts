import { describe, expect, it, vi } from "vitest";

import {
  placeMenuItems,
  planUsageSummary,
  profileInitials,
  profileMenuItems,
  resetsIn,
  accountDot,
  accountLabel,
  toolMenuItems,
  type PlanUsageWindows,
  profileLabel,
} from "./SidebarProfileMenu";
import { platformLabel } from "@/lib/app-links";
import { profileForSession } from "@/lib/session";


describe("profileInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(profileInitials({ name: "Morgan Shaw" })).toBe("MS");
    expect(profileInitials({ name: "Ada Byron Lovelace" })).toBe("AB");
  });

  it("falls back to the email, then to a placeholder", () => {
    expect(profileInitials({ email: "you@x.dev" })).toBe("Y");
    expect(profileInitials({})).toBe("?");
    expect(profileInitials(undefined)).toBe("?");
  });

  it("ignores whitespace-only names", () => {
    expect(profileInitials({ name: "   ", email: "you@x.dev" })).toBe("Y");
  });
});

describe("profileLabel", () => {
  it("prefers the name, then the email, then You", () => {
    expect(profileLabel({ name: "Owen", email: "o@x.dev" })).toBe("Owen");
    expect(profileLabel({ email: "o@x.dev" })).toBe("o@x.dev");
    expect(profileLabel(undefined)).toBe("You");
  });
});

describe("the sidebar profile for a signed-in visitor", () => {
  it("uses the fallback while the session identity is still loading", () => {
    const visible = profileForSession(
      { name: "Owner", email: "owner@example.test", avatarUrl: "/owner.png" },
      null,
    );
    expect(profileLabel(visible)).toBe("You");
    expect(profileInitials(visible)).toBe("?");
    expect(visible?.avatarUrl).toBeUndefined();
  });

  it("shows the verified email and initials without the configured owner's name or avatar", () => {
    const visible = profileForSession(
      { name: "Owner", email: "owner@example.test", avatarUrl: "/owner.png" },
      { kind: "session", id: "s", label: "Ada's iPad", email: "ada@example.test", scopes: ["client"], expiresAt: 1 },
    );
    expect(profileLabel(visible)).toBe("ada@example.test");
    expect(profileInitials(visible)).toBe("A");
    expect(visible?.avatarUrl).toBeUndefined();
  });
});

describe("platformLabel", () => {
  it("names the platforms we ship, and stays quiet otherwise", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("linux")).toBe("Linux");
    expect(platformLabel("freebsd")).toBeNull();
    expect(platformLabel(undefined)).toBeNull();
  });
});



describe("profileMenuItems", () => {
  const noop = () => {};
  const build = (patch: Partial<Parameters<typeof profileMenuItems>[0]> = {}) => profileMenuItems({
    usage: true,
    onUsage: noop, onSettings: noop, onShortcuts: noop, onAbout: noop,
    ...patch,
  });

  it("groups usage, support and settings", () => {
    const items = build();
    expect(items.map((item) => item.key)).toEqual(["usage", "support", "settings"]);
    expect(items.filter((item) => item.separatorBefore).map((item) => item.key)).toEqual([]);
    expect(items.find((item) => item.key === "support")!.submenu!.map((item) => item.key)).toEqual(["shortcuts", "about"]);
  });

  it("only offers usage when available", () => {
    const items = build({ usage: false });
    expect(items.map((item) => item.key)).toEqual(["support", "settings"]);
    expect(items.some((item) => item.separatorBefore)).toBe(false);
  });

  it("opens the Usage page of Settings", () => {
    const onUsage = vi.fn();
    const items = build({ onUsage });
    items.find((item) => item.key === "usage")!.onSelect();
    expect(onUsage).toHaveBeenCalledOnce();
  });
});

describe("the usage meta", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const window = (usedPercent: number | null, resetsAt: string | null = null) => ({ available: usedPercent !== null, usedPercent, resetsAt });
  const provider = (patch: Partial<PlanUsageWindows["providers"][number]> = {}) => ({ ok: true, plan: null, weekly: window(null), fiveHour: window(null), ...patch });

  it("reads the tightest weekly window, then the 5-hour one, with when it resets", () => {
    const report = { providers: [provider({ weekly: window(12, "2026-10-30T12:00:00Z") }), provider({ weekly: window(31.6, "2026-10-28T12:00:00Z") }), provider({ ok: false, weekly: window(90) })] };
    expect(planUsageSummary(report, now)).toEqual({ value: "32% used", weekly: true, resets: "Resets tomorrow" });
    expect(planUsageSummary({ providers: [provider({ fiveHour: window(40, "2026-10-27T15:00:00Z") })] }, now)).toEqual({ value: "40% used", weekly: false, resets: "Resets in 3 hours" });
  });

  it("falls back to a plan's monthly budget when it has no rolling window", () => {
    const report = { providers: [provider({ extra: [{ label: "Monthly spend", usedPercent: 9.3 }, { label: "Other", usedPercent: 80 }] })] };
    expect(planUsageSummary(report, now)).toEqual({ value: "9% used" });
    expect(planUsageSummary({ providers: [provider({ extra: [{ label: "Other", usedPercent: 80 }] })] }, now)).toBeNull();
  });

  it("shows nothing without a percent, not even the plan's name", () => {
    expect(planUsageSummary({ providers: [provider({ plan: "Max" })] }, now)).toBeNull();
    expect(planUsageSummary({ providers: [provider()] }, now)).toBeNull();
    expect(planUsageSummary(null, now)).toBeNull();
  });

  it("says when a reset is days away, and nothing once it has passed", () => {
    expect(resetsIn(now + 3 * 86_400_000, now)).toBe("Resets in 3 days");
    expect(resetsIn(now - 1, now)).toBeUndefined();
    expect(resetsIn(null, now)).toBeUndefined();
  });

});

describe("generic account and place guidance", () => {
  it("prioritizes actionable account indicators", () => {
    expect(accountLabel("Ada", { automationsNeedYou: false })).toBe("Ada");
    expect(accountDot({ automationsNeedYou: false })).toBeNull();
    expect(accountDot({ automationsNeedYou: true })).toBe("danger");
  });

  it("switches saved places and suppresses the duplicate action beside a rail", () => {
    const openMenu = vi.fn();
    const place = { bridge: undefined, current: { local: true, name: "This computer" }, cloudHome: false, openMenu, switchable: true };
    const items = placeMenuItems(place, {});
    expect(items.map(item => item.key)).toEqual(["place", "switch-place"]);
    expect(items[0]!.trailing).toBeTruthy();
    items.forEach(item => item.onSelect());
    expect(openMenu).toHaveBeenCalledTimes(2);
    expect(placeMenuItems(place, { besideRail: true }).map(item => item.key)).toEqual(["place"]);
    expect(placeMenuItems({ ...place, switchable: false }, {})).toEqual([]);
  });

  it("keeps simple-mode tools", () => {
    const noop = () => {};
    const tools = toolMenuItems({ activeView: "routines", automationsNeedYou: true, onAutomations: noop, onTeamMap: noop });
    expect(tools.map(item => [item.key, item.active, item.attention])).toEqual([["automations", true, true], ["team-map", false, undefined]]);
  });
});
