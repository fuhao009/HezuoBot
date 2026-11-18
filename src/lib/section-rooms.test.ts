import { describe, expect, it } from "vitest";

import { sectionRoomSteps } from "./section-rooms";

const bot = (id: string, section?: string, hidden = false) => ({ id, section, hidden });
const room = (id: string, section: string, memberIds: string[], written = 0) => ({ id, section, memberIds, messages: Array.from({ length: written }) });

describe("a group's chat follows its bots", () => {
  it("opens a chat for a new group of two", () => {
    expect(sectionRoomSteps([bot("a"), bot("b")], [], ["a", "b"], "Research")).toEqual([
      { kind: "create", section: "Research", memberIds: ["a", "b"] },
    ]);
  });

  it("adds a bot that joins a group to that group's chat", () => {
    const steps = sectionRoomSteps([bot("a", "Research"), bot("b", "Research"), bot("c")], [room("r", "Research", ["a", "b"])], ["c"], "Research");
    expect(steps).toEqual([{ kind: "members", groupId: "r", memberIds: ["a", "b", "c"] }]);
  });

  it("opens a chat for an older group once it has two bots", () => {
    expect(sectionRoomSteps([bot("a", "Research"), bot("b")], [], ["b"], "Research")).toEqual([
      { kind: "create", section: "Research", memberIds: ["a", "b"] },
    ]);
  });

  it("takes a bot that leaves a group out of that group's chat", () => {
    const bots = [bot("a", "Research"), bot("b", "Research"), bot("c", "Research")];
    expect(sectionRoomSteps(bots, [room("r", "Research", ["a", "b", "c"])], ["c"], "")).toEqual([
      { kind: "members", groupId: "r", memberIds: ["a", "b"] },
    ]);
  });

  it("deletes a chat nobody wrote in once its group has fewer than two bots", () => {
    const bots = [bot("a", "Research"), bot("b", "Research")];
    expect(sectionRoomSteps(bots, [room("r", "Research", ["a", "b"])], ["b"], "")).toEqual([{ kind: "delete", groupId: "r" }]);
  });

  it("keeps a chat with messages when its group has fewer than two bots", () => {
    const bots = [bot("a", "Research"), bot("b", "Research")];
    expect(sectionRoomSteps(bots, [room("r", "Research", ["a", "b"], 3)], ["b"], "")).toEqual([]);
  });

  it("moves a bot between two groups' chats", () => {
    const bots = [bot("a", "Research"), bot("b", "Research"), bot("c", "Research"), bot("d", "Support"), bot("e", "Support")];
    const rooms = [room("r", "Research", ["a", "b", "c"]), room("s", "Support", ["d", "e"])];
    expect(sectionRoomSteps(bots, rooms, ["c"], "Support")).toEqual([
      { kind: "members", groupId: "r", memberIds: ["a", "b"] },
      { kind: "members", groupId: "s", memberIds: ["d", "e", "c"] },
    ]);
  });

  it("does nothing for a bot already in the group, a hidden bot or a direct chat", () => {
    expect(sectionRoomSteps([bot("a", "Research"), bot("b", "Research")], [room("r", "Research", ["a", "b"])], ["a"], "Research")).toEqual([]);
    expect(sectionRoomSteps([bot("a", "Research"), bot("b", undefined, true)], [], ["b"], "Research")).toEqual([]);
    const direct = { ...room("d", "Research", ["a", "b"]), dm: true };
    expect(sectionRoomSteps([bot("a", "Research"), bot("b", "Research"), bot("c")], [direct], ["c"], "Research")).toEqual([
      { kind: "create", section: "Research", memberIds: ["a", "b", "c"] },
    ]);
  });
});
