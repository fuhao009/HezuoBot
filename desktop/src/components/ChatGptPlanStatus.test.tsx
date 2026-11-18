// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatGptPlanStatus } from "./ChatGptPlanStatus";

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: vi.fn() }));
vi.mock("./ProviderIcons", () => ({ CodexMark: () => null }));

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function welcomeVisible(instanceId = "codex") {
  return renderToStaticMarkup(createElement(ChatGptPlanStatus, { instanceId })).includes("data-chatgpt-plan-welcome");
}

describe("ChatGptPlanStatus welcome storage", () => {
  it("uses only the current instance's Hezuo acknowledgement", () => {
    localStorage.setItem("hezuo:chatgpt-plan-welcome:codex", "1");
    expect(welcomeVisible()).toBe(false);
    expect(welcomeVisible("other")).toBe(true);
  });

  it("does not read or migrate a legacy acknowledgement", () => {
    localStorage.setItem("omb:chatgpt-plan-welcome:codex", "1");
    const get = vi.spyOn(localStorage, "getItem");
    const set = vi.spyOn(localStorage, "setItem");
    expect(welcomeVisible()).toBe(true);
    expect(get).toHaveBeenCalledWith("hezuo:chatgpt-plan-welcome:codex");
    expect(get).not.toHaveBeenCalledWith("omb:chatgpt-plan-welcome:codex");
    expect(set).not.toHaveBeenCalled();
  });

  it("does not consult storage when welcome is disabled", () => {
    const get = vi.spyOn(localStorage, "getItem");
    const html = renderToStaticMarkup(createElement(ChatGptPlanStatus, { instanceId: "codex", welcome: false }));
    expect(html).not.toContain("data-chatgpt-plan-welcome");
    expect(get).not.toHaveBeenCalled();
  });

  it("still offers the welcome when storage is unavailable", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    expect(welcomeVisible()).toBe(true);
  });
});
