import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function stagedFileFixture() {
  const lent = { staged: [] };
  let ids = 0;
  const client = {
    staged: async (id) => lent.staged.filter((change) => change.syncId === id).map(({ id: changeId, path, bytes, base }) => ({ id: changeId, path, sha256: sha(bytes), size: bytes.length, baseSha256: base, at: 1 })),
    stagedFile: async (id, changeId, temporary) => {
      const change = lent.staged.find((entry) => entry.syncId === id && entry.id === changeId);
      writeFileSync(temporary, change.damaged ?? change.bytes);
      return { sha256: sha(change.bytes) };
    },
    stagedDone: async (id, changeId, sha256) => {
      lent.staged = lent.staged.filter((entry) => !(entry.syncId === id && entry.id === changeId && sha(entry.bytes) === sha256));
      return { ok: true };
    },
  };
  return {
    client,
    lent,
    stage(syncId, path, text, base = null) {
      const change = { id: `change-${++ids}`, syncId, path, bytes: Buffer.from(text), base };
      lent.staged.push(change);
      return change;
    },
  };
}
