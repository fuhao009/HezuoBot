import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

type RoutineShape = {
  prompt?: string; target?: unknown; botId?: string; groupId?: string; attachments?: { id: string; path: string }[];
  schedule?: unknown; runOn?: string;
};

/** The scheduler never rewrites these fields, so any edit by someone else changes the fingerprint. */
export function routineFingerprint(routine: RoutineShape): string {
  const attachments = (routine.attachments ?? []).map(attachment => [attachment.id, attachment.path]);
  return createHash("sha256").update(JSON.stringify([
    routine.prompt ?? "", routine.target ?? null, routine.botId ?? "", routine.groupId ?? null, attachments,
    routine.schedule ?? null, routine.runOn ?? null,
  ])).digest("hex");
}

const authorsFile = z.object({
  version: z.literal(1),
  routines: z.record(z.string().max(128), z.string().regex(/^[a-f0-9]{64}$/)),
  writers: z.record(z.string().max(128), z.string().regex(/^p_[\w-]{22}$/)).optional(),
}).strict();

/** A missing or damaged file means none: it never grants anything by being absent. */
export function createRoutineAuthors(file: string) {
  let routines: Record<string, string> = {};
  let writers: Record<string, string> = {};
  try {
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_000_000) {
        const parsed = authorsFile.parse(JSON.parse(readFileSync(file, "utf8")));
        routines = parsed.routines;
        writers = parsed.writers ?? {};
      }
    }
  } catch { routines = {}; writers = {}; }
  const save = () => writeFileAtomic(file, JSON.stringify({ version: 1, routines, writers }), { mode: 0o600 });
  return {
    record(id: string, routine: RoutineShape) { routines = { ...routines, [id]: routineFingerprint(routine) }; save(); },
    forget(id: string) { if (Object.hasOwn(routines, id)) { const next = { ...routines }; delete next[id]; routines = next; save(); } },
    wrote(id: string, person: string) { if (writers[id] !== person) { writers = { ...writers, [id]: person }; save(); } },
    writer(id: string): string | undefined { return Object.hasOwn(writers, id) ? writers[id] : undefined; },
    remove(id: string) {
      if (!Object.hasOwn(routines, id) && !Object.hasOwn(writers, id)) return;
      const nextRoutines = { ...routines }; delete nextRoutines[id]; routines = nextRoutines;
      const nextWriters = { ...writers }; delete nextWriters[id]; writers = nextWriters;
      save();
    },
    authored(id: string, routine: RoutineShape) { return Object.hasOwn(routines, id) && routines[id] === routineFingerprint(routine); },
    recorded(id: string): boolean { return Object.hasOwn(routines, id); },
    /** Writes the file even when nothing changed: its presence says records are being kept. */
    persist() { save(); },
    people(): Set<string> { return new Set(Object.values(writers)); },
    reassign(move: (person: string) => boolean, to: string): string[] {
      const moved: string[] = [];
      const next = { ...writers };
      for (const [id, person] of Object.entries(writers)) if (person !== to && move(person)) { next[id] = to; moved.push(id); }
      if (moved.length) { writers = next; save(); }
      return moved;
    },
  };
}

/** Adopt pre-recordkeeping routines only when ownership is unambiguous. */
export function adoptExistingRoutines<R extends { id: string }>(input: {
  recordsExisted: boolean; offered: boolean; otherPeople: boolean; routines: readonly R[];
  record(routine: R): void; persist(): void;
}): number {
  if (input.recordsExisted || !input.offered || input.otherPeople) return 0;
  for (const routine of input.routines) input.record(routine);
  input.persist();
  return input.routines.length;
}
