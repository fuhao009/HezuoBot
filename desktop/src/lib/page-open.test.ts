// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPublishedPageUrl, pagePanelBot, requestPanelPage, usePanelPage, withPageOpen, type PageOpenFacts, type PanelPage } from "./page-open";

const PAGES_ORIGIN = "https://pages.example.test";
const PAGE = "https://abcdefghijklmnopqrstuvwxyz.pages.example.test/";
const facts = (over: Partial<PageOpenFacts> = {}): PageOpenFacts => ({
  selectedId: "pepper", bots: [{ id: "pepper" }], groups: [{ id: "room" }],
  config: { features: { browser: true }, browserEngine: { kind: "engine" } }, desktop: {}, ...over,
});

beforeEach(() => { vi.stubEnv("VITE_HEZUO_PAGES_ORIGIN", PAGES_ORIGIN); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("a published page's link", () => {
  it("accepts only a page ID under the configured HTTPS hosting domain", () => {
    expect(isPublishedPageUrl(PAGE)).toBe(true);
    expect(isPublishedPageUrl(`${PAGE}charts/index.html?region=EU#top`)).toBe(true);
    for (const other of [
      "hezuobot://thread/t1?bot=pepper", "hezuobot://bot/pepper", "http://abcdefghijklmnopqrstuvwxyz.pages.example.test/",
      "https://pages.example.test/", "https://www.pages.example.test/", "https://upload.pages.example.test/", "https://a.b.abcdefghijklmnopqrstuvwxyz.pages.example.test/",
      "https://abcdefghijklmnopqrstuvwxyz.pages.example.test.evil.test/", "https://abcdefghijklmnopqrstuvwxyz.pages.example.tests/",
      "https://user:pw@abcdefghijklmnopqrstuvwxyz.pages.example.test/", "https://abcdefghijklmnopqrstuvwxyz.pages.example.test:8443/",
      "https://abcdefghijklmnopqrstuvwxyz.hezuobot.page/",
      "https://abcdefghijklmnopqrstuvwxyz.pages.example.test:443/",
      "https://abcdefghijklmnopqrstuvwxyz.pages.example.test/\\evil.test",
      "javascript:alert(1)", "not a url", "", undefined, null,
    ]) expect(isPublishedPageUrl(other), String(other)).toBe(false);
  });

  it("does not route pages without a valid hosting origin", () => {
    for (const origin of [undefined, "", "http://pages.example.test", `${PAGES_ORIGIN}:443`,
      `${PAGES_ORIGIN}/path`, `${PAGES_ORIGIN}?`, "https://*.example.test", "https://user@pages.example.test"]) {
      vi.stubEnv("VITE_HEZUO_PAGES_ORIGIN", origin);
      expect(isPublishedPageUrl(PAGE), String(origin)).toBe(false);
      expect(pagePanelBot(PAGE, facts())).toBeNull();
    }
  });
});

describe("where a published page opens", () => {
  it("in the desktop app, in the open bot chat's browser panel when that browser is on and installed", () => {
    expect(pagePanelBot(PAGE, facts())).toBe("pepper");
  });

  it("outside the chat everywhere else: the web, the remote client, a room, a bot without its browser, or a browser not ready", () => {
    const cases: Array<[string, Partial<PageOpenFacts>]> = [
      ["web", { desktop: undefined }],
      ["remote client", { desktop: { remoteClient: { active: true } } }],
      ["room", { selectedId: "room" }],
      ["no bot", { selectedId: "gone" }],
      ["bot's browser off", { bots: [{ id: "pepper", browser: false }] }],
      ["browser feature off", { config: { features: { browser: false }, browserEngine: { kind: "engine" } } }],
      ["not installed", { config: { features: { browser: true }, browserEngine: { kind: "unavailable", installable: true } } }],
      ["installing", { config: { features: { browser: true }, browserEngine: { kind: "engine", installing: true } } }],
      ["install failed", { config: { features: { browser: true }, browserEngine: { kind: "engine", installError: "disk full" } } }],
    ];
    for (const [name, over] of cases) expect(pagePanelBot(PAGE, facts(over)), name).toBeNull();
  });

  it("never sends any other link to the panel", () => {
    for (const link of ["https://example.com/", "hezuobot://thread/t1?bot=pepper", "https://pages.example.test/"]) expect(pagePanelBot(link, facts())).toBeNull();
  });
});

describe("the panel's page requests", () => {
  const roots: Array<{ unmount(): void }> = [];
  afterEach(() => { for (const root of roots.splice(0)) root.unmount(); vi.useRealTimers(); });
  function panel(botId: string) {
    const got: PanelPage[] = [];
    const container = document.createElement("div"), root = createRoot(container);
    roots.push(root);
    function Panel() { usePanelPage(botId, (page) => got.push(page)); return null; }
    flushSync(() => root.render(createElement(Panel)));
    return got;
  }

  it("go once to the bot's panel, open now or opening next, and never to another bot's", () => {
    const pepper = panel("pepper"), salt = panel("salt");
    requestPanelPage("pepper", PAGE);
    expect(pepper.map((page) => page.url)).toEqual([PAGE]);
    expect(salt).toEqual([]);
    requestPanelPage("basil", PAGE);
    expect(panel("basil").map((page) => page.url)).toEqual([PAGE]);
    expect(panel("basil")).toEqual([]);
  });

  it("are dropped once stale, so a panel opened much later opens nothing by itself", () => {
    requestPanelPage("thyme", PAGE, Date.now() - 60_000);
    expect(panel("thyme")).toEqual([]);
  });
});

describe("a page link's click", () => {
  const click = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

  it("opens the page like its card's Open, after the link's own handler", () => {
    const open = vi.fn(), own = vi.fn();
    const event = click();
    withPageOpen(PAGE, open, { onClick: own }).onClick!(event as never);
    expect(own).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith(PAGE);
  });

  it("stays taken when the link's own handler took it (a long press), and leaves other links alone", () => {
    const open = vi.fn();
    withPageOpen(PAGE, open, { onClick: (event) => event.preventDefault() }).onClick!(click() as never);
    expect(open).not.toHaveBeenCalled();
    const anchor = { onClick: vi.fn() };
    expect(withPageOpen("https://example.com/", open, anchor)).toBe(anchor);
  });
});
