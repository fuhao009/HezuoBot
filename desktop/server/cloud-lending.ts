// Who may use a lent computer: only a turn the harness can prove acts for the owner (a conversation they
// started from their own admin-scoped device, a room member answering their own line there, or a routine they wrote or
// started by hand), in a conversation they opened that has never held anybody else's words, since a resumed session
// carries everything said in it. Webhooks, guests, work handed in from elsewhere and anything unprovable never can.
export { createRoutineAuthors as createCloudRoutineAuthors, routineFingerprint } from "./routine-authors.ts";
import type { RoutineRunTrigger } from "./routines.ts";

type Card = { requestId?: string; answered?: string; answeredText?: string; dismissed?: boolean; autoApplied?: boolean; answeredBy?: { kind: string; person?: string } };
type Line = { id: string; role: string; peerAsk?: unknown; sender?: { id?: string }; card?: Card };

export interface CloudLendingTurn {
  request: { messageId?: string; generations: ReadonlySet<string>; stopped?: boolean; automation?: RoutineRunTrigger } | undefined;
  generation: string;
  thread: readonly Line[];
  /** Whoever opened the conversation chose its title, so they must be the owner too. */
  starters?: readonly (string | undefined)[];
  /** Words someone else chose: a "post" webhook's payload, or a report of a routine the owner did not write. */
  reportsFromOthers?: boolean;
  ownerPerson: (person: string | undefined) => boolean;
  cardAnswerer: (card: Card) => string | undefined;
  routineRun: () => { triggerSource: RoutineRunTrigger; ownerStarted: boolean; ownerAuthored: boolean } | null;
}

const personOf = (line: Line | undefined) => line?.role === "user" && !line.peerAsk ? line.sender?.id : undefined;

export type CloudLendingRefusal = "unproven" | "not-owner" | "someone-else";

/** Why a turn can't use the lent computer, in the words its bot says and a refused call answers. `room`: a group chat.
 * `fromBefore`: historical lines whose authors cannot be verified. */
export function cloudLendingRefusalText(why: CloudLendingRefusal | "memory-changed", { room, fromBefore, device }: { room: boolean; fromBefore: boolean; device: "Mac" | "PC" | "computer" }): string {
  const yours = `your ${device}`;
  const fresh = room ? "Start a new thread in this group chat to use it." : "Start a new conversation with this bot to use it.";
  if (why === "memory-changed") return `This bot's memory was changed in a conversation you didn't write. Review it in Memory to use ${yours} again.`;
  if (why === "someone-else" && fromBefore) return `This conversation has messages whose authors cannot be verified, so it can't use ${yours}. ${fresh}`;
  if (why === "someone-else") return `Someone else wrote in this conversation, so it can't use ${yours}. ${room ? fresh : "Start a new conversation to use it."}`;
  if (room) return `Only your own messages in a group chat, and the bots that answer them there, can use ${yours}. Ask here yourself to use it.`;
  return `Only conversations you start with a bot, and routines you wrote, can use ${yours}. Start a new conversation with this bot to use it.`;
}

export function cloudHomeLendingRefusal(turn: CloudLendingTurn): CloudLendingRefusal | null {
  const { request } = turn;
  if (!request?.messageId || request.stopped || !request.generations.has(turn.generation)) return "unproven";
  const index = turn.thread.findIndex(line => line.id === request.messageId);
  if (index < 0) return "unproven";
  let owner: boolean;
  if (request.automation === undefined) {
    owner = turn.ownerPerson(personOf(turn.thread[index]));
  } else {
    const run = turn.routineRun();
    owner = request.automation !== "webhook" && Boolean(run) && run!.triggerSource !== "webhook" &&
      run!.ownerAuthored && (run!.triggerSource !== "manual" || run!.ownerStarted);
  }
  if (!owner) return "not-owner";
  // A conversation someone else opened (and named) is theirs, whoever writes in it.
  if (turn.starters?.some((person) => person !== undefined && !turn.ownerPerson(person))) return "someone-else";
  if (turn.reportsFromOthers) return "someone-else";
  // No line (sent, queued, steered or handed in) and no card answer by anyone else, ever; a routine's own prompt names nobody.
  const clean = ownerOnlyConversation(turn.thread, turn.ownerPerson, turn.cardAnswerer,
    request.automation !== undefined ? request.messageId : undefined);
  return clean ? null : "someone-else";
}

/** Every user line and every answered card is the owner's; the same test gates what feeds a turn on a Cloud home. */
export function ownerOnlyConversation(
  thread: readonly Line[],
  ownerPerson: (person: string | undefined) => boolean,
  cardAnswerer: (card: Card) => string | undefined,
  exempt?: string,
): boolean {
  return thread.every(line =>
    (line.role !== "user" || line.id === exempt || ownerPerson(personOf(line))) &&
    (!answeredByPerson(line.card) || ownerPerson(cardAnswerer(line.card!))));
}

/** The harness's own settlements (dismissed, unavailable, a bot's change applied on its own, or a question a bot decided)
 * carry nobody's words. */
export function answeredByPerson(card: Card | undefined): boolean {
  if (!card || card.answeredBy?.kind === "bot") return false;
  return (Boolean(card.answered) && card.answered !== "unavailable" && card.dismissed !== true && card.autoApplied !== true) || Boolean(card.answeredText);
}
