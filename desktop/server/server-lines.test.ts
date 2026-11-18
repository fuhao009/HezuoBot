import { describe, expect, it } from "vitest";

import "./server-line-packs.ts";
import { serverLine } from "./server-lines.ts";

describe("serverLine", () => {
  it("writes the line in the language given, with its values filled in", () => {
    expect(serverLine("de", "server.greeting.hello", { name: "Scout" })).toBe("Hallo, ich bin Scout. Was soll ich für dich tun?");
    expect(serverLine(undefined, "server.greeting.hello", { name: "Scout" })).toBe("Hi, I'm Scout. What would you like me to do?");
  });

  it("reads a regional tag as its language, and a language it has no words for as English", () => {
    const greeting = (language: string) => serverLine(language, "server.greeting.hello");
    expect(greeting("de-AT")).toBe(greeting("de"));
    expect(greeting("pt")).toBe(greeting("pt-br"));
    expect(greeting("zh-Hant")).toBe(greeting("zh-tw"));
    expect(greeting("nl")).toBe(greeting("en"));
  });

  it("leaves a {name} it was given no value for as it is", () => {
    expect(serverLine("en", "server.greeting.hello", {})).toBe("Hi, I'm {name}. What would you like me to do?");
  });

  it.each(["zh", "zh-Hant", "en", "ko"])("writes welcome and setup lines in %s", (language) => {
    expect(serverLine(language, "server.greeting.hello", { name: "Scout" })).toContain("Scout");
    expect(serverLine(language, "server.helper.hello", { name: "Scout" })).toContain("Scout");
    expect(serverLine(language, "server.setup.choice.research")).not.toContain("server.");
    expect(serverLine(language, "server.product.welcome")).not.toContain("server.");
    if (language !== "en") {
      expect(serverLine(language, "server.setup.choice.research")).not.toBe(serverLine("en", "server.setup.choice.research"));
      expect(serverLine(language, "server.product.welcome")).not.toBe(serverLine("en", "server.product.welcome"));
    }
  });
});
