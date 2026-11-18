import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserStateStore, type BrowserState } from '../src/browser-state.ts';

const state: BrowserState = {
  cookies: [{ name: 'session', value: 'PRIVATE-secret', domain: '.example.com', path: '/',
    expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'PRIVATE-token' }] }],
};
let root: string;
let directory: string;
let file: string;
let store: BrowserStateStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'browser-state-test-'));
  directory = join(root, 'private');
  file = join(directory, 'browser-state.json');
  store = new BrowserStateStore(directory);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function put(content: string | Buffer) {
  await mkdir(directory, { mode: 0o700 });
  await writeFile(file, content, { mode: 0o600 });
}
async function refused() {
  assert.deepEqual(await store.load(), { state: undefined, status: 'Saved browser state is invalid or unsafe.' });
  await assert.rejects(store.save(state), /^Error: Unable to save browser state\.$/);
  await assert.rejects(store.clear(), /^Error: Unable to clear browser state\.$/);
}

describe('BrowserStateStore', () => {
  it('returns missing without creating a directory; clear is idempotent', async () => {
    assert.deepEqual(await store.load(), { state: undefined, status: 'No saved browser state.' });
    await store.clear();
    assert.deepEqual(await readdir(root), []);
  });

  it('round trips storage state with private modes', async () => {
    await store.save(state);
    assert.deepEqual(await store.load(), { state, status: 'Saved browser state loaded.' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), state);
    if (process.platform !== 'win32') {
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
    }
    assert.deepEqual(await readdir(directory), ['browser-state.json']);
  });

  it('replaces atomically rather than truncating the old inode', async () => {
    await store.save(state);
    const previous = await lstat(file);
    await store.save({ cookies: [], origins: [] });
    assert.notEqual((await lstat(file)).ino, previous.ino);
    assert.deepEqual((await store.load()).state, { cookies: [], origins: [] });
    assert.deepEqual(await readdir(directory), ['browser-state.json']);
  });

  it('supports partition keys and IndexedDB snapshots', async () => {
    const extended = {
      cookies: [{ ...state.cookies[0], partitionKey: 'https://example.com' }],
      origins: [{ ...state.origins[0], indexedDB: [{ name: 'db', version: 1, stores: [{
        name: 'store', autoIncrement: false, keyPath: 'id', records: [{ value: { id: 1 } }],
        indexes: [{ name: 'id', keyPath: 'id', unique: true, multiEntry: false }],
      }] }] }],
    } as BrowserState;
    await store.save(extended);
    assert.deepEqual((await store.load()).state, extended);
  });

  for (const [index, content] of [
    'PRIVATE-secret not JSON', 'null', '[]', '{}',
    '{"cookies":[],"origins":[],"extra":"PRIVATE"}',
    '{"cookies":{},"origins":[]}',
    JSON.stringify({ cookies: [{ ...state.cookies[0], secure: 'yes' }], origins: [] }),
    JSON.stringify({ cookies: [{ ...state.cookies[0], sameSite: 'invalid' }], origins: [] }),
    JSON.stringify({ cookies: [{ ...state.cookies[0], expires: null }], origins: [] }),
    JSON.stringify({ cookies: [{ name: 'only-name' }], origins: [] }),
    JSON.stringify({ cookies: [], origins: [{ origin: 'not-an-origin', localStorage: [] }] }),
    JSON.stringify({ cookies: [], origins: [{ origin: 'https://example.com/path', localStorage: [] }] }),
    JSON.stringify({ cookies: [], origins: [{ origin: 'https://example.com', localStorage: [{ name: 'x', value: 42 }] }] }),
    JSON.stringify({ cookies: [], origins: [{ origin: 'https://example.com', localStorage: [], indexedDB: [{}] }] }),
    '{"cookies":[],"origins":[]} trailing',
  ].entries()) {
    it(`rejects malformed state ${index} without exposing or altering it`, async () => {
      await put(content);
      assert.deepEqual(await store.load(), { state: undefined, status: 'Saved browser state is invalid or unsafe.' });
      assert.equal(await readFile(file, 'utf8'), content);
    });
  }

  it('rejects invalid UTF-8', async () => {
    await put(Buffer.from([0xff, 0xfe]));
    assert.equal((await store.load()).state, undefined);
  });

  it('round-trips valid state beyond the former four MiB quota', async () => {
    const huge: BrowserState = { cookies: [], origins: [{ origin: 'http://localhost:8080',
      localStorage: [{ name: 'huge', value: 'x'.repeat(4 * 1024 * 1024 + 1) }] }] };
    await store.save(huge);
    assert.deepEqual((await store.load()).state, huge);
    assert.deepEqual(await readdir(directory), ['browser-state.json']);
  });

  it('sanitizes invalid runtime arguments and preserves saved data', async () => {
    await store.save(state);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [null, {}, { ...state, cookies: [{}] }, cyclic, { toJSON() { throw new Error('PRIVATE'); } }]) {
      await assert.rejects(store.save(value as BrowserState), /^Error: Unable to save browser state\.$/);
    }
    assert.deepEqual((await store.load()).state, state);
    assert.deepEqual(await readdir(directory), ['browser-state.json']);
  });

  it('clears only the fixed file', async () => {
    await store.save(state);
    await writeFile(join(directory, 'unrelated'), 'keep');
    await store.clear();
    await store.clear();
    assert.deepEqual(await readdir(directory), ['unrelated']);
    assert.equal(await readFile(join(directory, 'unrelated'), 'utf8'), 'keep');
  });

  it('refuses state directories', async () => {
    await mkdir(directory, { mode: 0o700 });
    await mkdir(file, { mode: 0o700 });
    await refused();
    assert.equal((await lstat(file)).isDirectory(), true);
  });

  it('refuses symlink directories', { skip: process.platform === 'win32' }, async () => {
    const target = join(root, 'target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, directory);
    await refused();
    assert.deepEqual(await readdir(target), []);
    assert.equal((await lstat(directory)).isSymbolicLink(), true);
  });

  it('refuses both existing and dangling file symlinks', { skip: process.platform === 'win32' }, async () => {
    await mkdir(directory, { mode: 0o700 });
    const target = join(root, 'secret');
    for (const exists of [true, false]) {
      if (exists) await writeFile(target, 'PRIVATE', { mode: 0o600 });
      else await rm(target);
      await symlink(target, file);
      await refused();
      assert.equal((await lstat(file)).isSymbolicLink(), true);
      if (exists) assert.equal(await readFile(target, 'utf8'), 'PRIVATE');
      await rm(file);
    }
  });

  it('refuses unsafe directory permissions without silently repairing them', { skip: process.platform === 'win32' }, async () => {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o755);
    await refused();
    assert.equal((await lstat(directory)).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(directory), []);
  });

  it('refuses unsafe file permissions', { skip: process.platform === 'win32' }, async () => {
    await store.save(state);
    await chmod(file, 0o644);
    await refused();
    assert.equal((await lstat(file)).mode & 0o777, 0o644);
  });

  it('refuses hard links', { skip: process.platform === 'win32' }, async () => {
    await store.save(state);
    const alias = join(root, 'alias');
    await link(file, alias);
    await refused();
    assert.deepEqual(JSON.parse(await readFile(alias, 'utf8')), state);
  });

  it('sanitizes non-directory failures', async () => {
    await writeFile(directory, 'PRIVATE');
    await refused();
    assert.equal(await readFile(directory, 'utf8'), 'PRIVATE');
  });
});
