import { describe, expect, it, vi } from "vitest";
import { initialState, reducer, type Action, type Bot } from "./store";

describe("New bot", () => {
  it("opens one review dialog from a double click without replacing its callbacks", () => {
    const onCreated = vi.fn();
    const onError = vi.fn();
    const action: Extract<Action, { type: "newBot" }> = { type: "newBot", onCreated, onError };
    const opened = reducer(initialState, action);
    expect(opened.pendingNewBot).toBe(action);
    expect(opened.bots).toBe(initialState.bots);
    expect(opened.selectedId).toBe(initialState.selectedId);
    expect(opened.activeView).toBe(initialState.activeView);
    expect(reducer(opened, { type: "newBot", onCreated: vi.fn() })).toBe(opened);
    expect(onCreated).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("lets a new click open another draft after the dialog closes", () => {
    const opened = reducer(initialState, { type: "newBot" });
    const closed = reducer(opened, { type: "closeNewBot" });
    expect(closed.pendingNewBot).toBeNull();
    const onCreated = vi.fn();
    const action: Extract<Action, { type: "newBot" }> = { type: "newBot", onCreated };
    expect(reducer(closed, action).pendingNewBot).toBe(action);
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("setup navigation", () => {
  it.each([false, true])("preserves the current selection only for nested team creation (%s)", preserveSelection => {
    const bot = { id: "created", name: "Scout", messages: [] } as unknown as Bot;
    const state = { ...initialState, activeView: "team-map" as const, selectedId: "existing" };
    const next = reducer(state, { type: "botAdded", bot, preserveSelection });
    expect(next.bots).toContain(bot);
    expect(next.activeView).toBe(preserveSelection ? "team-map" : "chat");
    expect(next.selectedId).toBe(preserveSelection ? "existing" : "created");
    expect(reducer(state, { type: "botAdded", bot })).toMatchObject({ activeView: "chat", selectedId: "created" });
  });

  it("closes setup surfaces while retaining the department dialog's creation context", () => {
    const start = { ...initialState, settingsOpen: true, appSettingsOpen: true, pluginsOpen: true, shortcutsOpen: true, computerOpen: true };
    expect(reducer(start, { type: "newBot" })).toMatchObject({ settingsOpen: false, appSettingsOpen: false, pluginsOpen: false, shortcutsOpen: false, computerOpen: true, pendingNewBot: { type: "newBot" } });
    const action: Extract<Action, { type: "newBot" }> = { type: "newBot", section: "Sales", preserveSelection: true };
    const next = reducer(start, action);
    expect(next.pendingNewBot).toBe(action);
    expect(next.selectedId).toBe(start.selectedId);
    expect(next.activeView).toBe(start.activeView);
    expect(next).toMatchObject({ settingsOpen: false, appSettingsOpen: false, pluginsOpen: false, shortcutsOpen: false, computerOpen: true });
  });

  it("opens the requested Plugins surface and remembers it on reopen", () => {
    const next = reducer({ ...initialState, settingsOpen: true }, { type: "togglePlugins", open: true, surface: "mcp" });
    expect(next).toMatchObject({ pluginsOpen: true, pluginsSurface: "mcp", settingsOpen: false });
    const closed = reducer(next, { type: "togglePlugins", open: false });
    expect(reducer(closed, { type: "togglePlugins", open: true })).toMatchObject({ pluginsSurface: "mcp" });
  });
});
