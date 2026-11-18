import { describe, expect, it, vi } from "vitest";

import { pairedDestination, revealPhonePairing } from "./phone-pairing";

describe("revealing a pairing card", () => {
  type Focusable = { focus: (options?: FocusOptions) => void };
  const focusable = () => ({ focus: vi.fn<(options?: FocusOptions) => void>() });
  const element = (action: Focusable | null) => ({
    scrollIntoView: vi.fn<(options: ScrollIntoViewOptions) => void>(),
    focus: vi.fn<(options?: FocusOptions) => void>(),
    querySelector: vi.fn((_selector: string) => action),
  });
  const now = (callback: () => void) => callback();

  it("scrolls the card into view and focuses the button that shows the code", () => {
    const action = focusable();
    const root = element(action);
    expect(revealPhonePairing(root, now)).toBe(true);
    expect(root.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(root.querySelector).toHaveBeenCalledWith("[data-phone-pairing-action]:not([disabled])");
    expect(action.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(root.focus).not.toHaveBeenCalled();
  });

  it("focuses the card itself when there is no button to press yet", () => {
    const root = element(null);
    revealPhonePairing(root, now);
    expect(root.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("waits a frame, and reports a card that is not drawn yet", () => {
    const root = element(focusable());
    const frames: Array<() => void> = [];
    revealPhonePairing(root, (callback) => frames.push(callback));
    expect(root.scrollIntoView).not.toHaveBeenCalled();
    frames[0]!();
    expect(root.scrollIntoView).toHaveBeenCalled();
    expect(revealPhonePairing(null, now)).toBe(false);
  });
});

describe("the destination after pairing", () => {
  it("only accepts paths on this server", () => {
    expect(pairedDestination("?desktop-settings=phone")).toBe("/");
    expect(pairedDestination("?next=/bots")).toBe("/bots");
    expect(pairedDestination("?next=//evil.example")).toBe("/");
    expect(pairedDestination("?next=https://evil.example")).toBe("/");
    expect(pairedDestination("?next=/pair")).toBe("/");
    expect(pairedDestination("")).toBe("/");
  });
});
