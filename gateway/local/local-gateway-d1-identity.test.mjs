import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { miniflareRuntime } from "../../scripts/product-fixture/runtime.mjs";
import { assertCanonicalD1State, d1ObjectId, GATEWAY_D1_ID } from "./local-gateway/d1-identity.mjs";
import { d1DatabaseFiles } from "./local-gateway/operator-bootstrap.mjs";

async function withStore(identity, check) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "hezuo-d1-state-test-"));
  const runtime = await miniflareRuntime();
  let mf;
  try {
    if (identity) {
      mf = new runtime.Miniflare(runtime.convertV4MiniflareOptions({
        host: "127.0.0.1",
        port: 0,
        modules: true,
        script: 'export default { fetch() { return new Response(); } };',
        d1Databases: { DB: identity },
        resourcePersistencePath: path.join(dataDir, "state"),
        resourceTmpPath: path.join(dataDir, "tmp"),
      }));
      const db = await mf.getD1Database("DB");
      await db.exec("CREATE TABLE preserved (value TEXT NOT NULL); INSERT INTO preserved VALUES ('account-and-ledger-sentinel');");
      await mf.dispose();
      mf = null;
    }
    await check({ runtime, dataDir });
  } finally {
    try {
      if (mf) await mf.dispose();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

it("allows a fresh store without creating a database", async () => {
  await withStore(null, async ({ runtime, dataDir }) => {
    await expect(assertCanonicalD1State(runtime, dataDir)).resolves.toBeUndefined();
    expect(d1DatabaseFiles(dataDir)).toEqual([]);
  });
}, 60_000);

it("derives the exact real D1 filename and accepts its unique canonical store", async () => {
  await withStore(GATEWAY_D1_ID, async ({ runtime, dataDir }) => {
    const files = d1DatabaseFiles(dataDir);
    expect(files).toHaveLength(1);
    expect(path.basename(files[0])).toBe(`${await d1ObjectId(runtime, GATEWAY_D1_ID)}.sqlite`);
    const before = readFileSync(files[0]);
    await expect(assertCanonicalD1State(runtime, dataDir)).resolves.toBeUndefined();
    expect(readFileSync(files[0])).toEqual(before);
    expect(d1DatabaseFiles(dataDir)).toEqual(files);
  });
}, 60_000);

it("rejects a noncanonical store without opening a replacement or modifying its contents", async () => {
  await withStore("different-persistence-identity", async ({ runtime, dataDir }) => {
    const files = d1DatabaseFiles(dataDir);
    expect(files).toHaveLength(1);
    const before = readFileSync(files[0]);
    await expect(assertCanonicalD1State(runtime, dataDir)).rejects.toThrow("does not uniquely match");
    expect(d1DatabaseFiles(dataDir)).toEqual(files);
    expect(readFileSync(files[0])).toEqual(before);
  });
}, 60_000);

it("rejects ambiguous stores even when one database has the canonical identity", async () => {
  await withStore(GATEWAY_D1_ID, async ({ runtime, dataDir }) => {
    const [canonical] = d1DatabaseFiles(dataDir);
    copyFileSync(canonical, path.join(path.dirname(canonical), "another-object.sqlite"));
    const files = d1DatabaseFiles(dataDir);
    const before = files.map(file => readFileSync(file));
    await expect(assertCanonicalD1State(runtime, dataDir)).rejects.toThrow("does not uniquely match");
    expect(d1DatabaseFiles(dataDir)).toEqual(files);
    files.forEach((file, index) => expect(readFileSync(file)).toEqual(before[index]));
  });
}, 60_000);
