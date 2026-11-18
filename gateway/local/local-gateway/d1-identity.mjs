import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { d1DatabaseFiles } from "./operator-bootstrap.mjs";

export const GATEWAY_D1_ID = "hezuo-local-gateway";

/** Ask the pinned workerd to calculate its ID; do not reproduce its hash algorithm. */
export async function d1ObjectId(runtime, name) {
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-d1-identity-"));
  let mf;
  try {
    mf = new runtime.Miniflare(runtime.convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      modules: true,
      script: 'export class Identity { fetch() { return new Response(); } } export default { fetch(request, env) { return new Response(env.ID.idFromName(new URL(request.url).searchParams.get("name")).toString()); } };',
      durableObjects: { ID: { className: "Identity", unsafeUniqueKey: "miniflare-D1DatabaseObject" } },
      resourcePersistencePath: directory,
      resourceTmpPath: path.join(directory, "tmp"),
    }));
    const response = await mf.dispatchFetch(`http://localhost/?name=${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error("Unable to derive the canonical D1 persistence identity");
    const id = await response.text();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid D1 persistence identity returned by workerd");
    return id;
  } finally {
    try {
      if (mf) await mf.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

/** Fresh installs may initialize; existing stores must already have the exact canonical object. */
export async function assertCanonicalD1State(runtime, dataDir) {
  const files = d1DatabaseFiles(dataDir);
  if (files.length === 0) return;
  const expected = `${await d1ObjectId(runtime, GATEWAY_D1_ID)}.sqlite`;
  if (files.length !== 1 || path.basename(files[0]) !== expected) {
    throw new Error("D1 state does not uniquely match the canonical gateway identity. Stop all writers and complete the documented offline cutover; no database was opened or selected.");
  }
}
