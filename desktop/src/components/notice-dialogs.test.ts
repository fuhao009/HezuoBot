// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { otherDialogOpen } from "./notice-dialogs";

afterEach(() => document.body.replaceChildren());

function visibleElement(attributes: Record<string, string>) {
  const element = document.createElement("div");
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  element.checkVisibility = () => true;
  document.body.append(element);
  return element;
}

it("blocks local guidance while account/login or legal dialogs are open", () => {
  visibleElement({ role: "dialog" });
  expect(otherDialogOpen()).toBe(true);
});

it("blocks on onboarding cards", () => {
  visibleElement({ "data-tour-card": "" });
  expect(otherDialogOpen()).toBe(true);
});

it("does not treat a removed marketing popup as queue-owned", () => {
  visibleElement({ role: "dialog", "data-whats-new-popup": "" });
  expect(otherDialogOpen()).toBe(true);
});

it("allows guidance when there is no competing dialog", () => {
  expect(otherDialogOpen()).toBe(false);
});
