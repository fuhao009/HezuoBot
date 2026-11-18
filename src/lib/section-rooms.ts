export type SectionRoomStep =
  | { kind: "create"; section: string; memberIds: string[] }
  | { kind: "members"; groupId: string; memberIds: string[] }
  | { kind: "delete"; groupId: string };

interface SectionBot {
  id: string;
  section?: string;
  hidden?: boolean;
}

interface SectionRoom {
  id: string;
  section?: string;
  dm?: boolean;
  memberIds: readonly string[];
  messages: readonly unknown[];
  tasks?: readonly unknown[];
}

const MIN_ROOM_MEMBERS = 2;

const sectionOf = (bot: SectionBot) => bot.section?.trim() ?? "";

const sameMembers = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));

const unused = (room: SectionRoom) => room.messages.length === 0 && (room.tasks?.length ?? 0) <= 1;

/** What a group's chat does when `moved` bots go to the group `to` (`""`: out of every group): the bots join the chat of
 * the group they enter and leave the chat of the group they left. A group of two or more with no chat gets one; a chat
 * left with fewer than two is deleted only while nobody has written in it. */
export function sectionRoomSteps(
  bots: readonly SectionBot[],
  rooms: readonly SectionRoom[],
  moved: readonly string[],
  to: string,
): SectionRoomStep[] {
  const visible = bots.filter((bot) => !bot.hidden);
  const movers = visible.filter((bot) => moved.includes(bot.id) && sectionOf(bot) !== to);
  if (!movers.length) return [];
  const moverIds = movers.map((bot) => bot.id);
  const roomOf = (section: string) => rooms.find((room) => !room.dm && (room.section?.trim() ?? "") === section);
  const steps: SectionRoomStep[] = [];

  for (const section of new Set(movers.map(sectionOf).filter(Boolean))) {
    const room = roomOf(section);
    if (!room) continue;
    const memberIds = room.memberIds.filter((id) => !moverIds.includes(id));
    if (memberIds.length >= MIN_ROOM_MEMBERS) {
      if (!sameMembers(memberIds, room.memberIds)) steps.push({ kind: "members", groupId: room.id, memberIds });
    } else if (unused(room)) {
      steps.push({ kind: "delete", groupId: room.id });
    }
  }

  if (to) {
    const room = roomOf(to);
    if (room) {
      const memberIds = [...room.memberIds, ...moverIds.filter((id) => !room.memberIds.includes(id))];
      if (!sameMembers(memberIds, room.memberIds)) steps.push({ kind: "members", groupId: room.id, memberIds });
    } else {
      const memberIds = [...visible.filter((bot) => sectionOf(bot) === to && !moverIds.includes(bot.id)).map((bot) => bot.id), ...moverIds];
      if (memberIds.length >= MIN_ROOM_MEMBERS) steps.push({ kind: "create", section: to, memberIds });
    }
  }
  return steps;
}
