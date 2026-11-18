import type { BrowserContext } from 'playwright';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export type BrowserState = Awaited<ReturnType<BrowserContext['storageState']>>;
const MISSING = 'No saved browser state.';
const UNAVAILABLE = 'Saved browser state is invalid or unsafe.';
const FAILURE = 'Unable to save browser state.';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function text(value: unknown): value is string { return typeof value === 'string'; }
function keyPath(value: unknown): boolean {
  return value === null || text(value) || (Array.isArray(value) && value.every(text));
}
function database(value: unknown): boolean {
  if (!record(value) || !keys(value, ['name', 'version', 'stores']) || !text(value.name) ||
      !Number.isSafeInteger(value.version) || (value.version as number) < 1 || !Array.isArray(value.stores)) return false;
  return value.stores.every(store => record(store) &&
    keys(store, ['name', 'autoIncrement', 'keyPath', 'records', 'indexes']) && text(store.name) &&
    typeof store.autoIncrement === 'boolean' && keyPath(store.keyPath) &&
    Array.isArray(store.records) && store.records.every(entry => record(entry) && keys(entry, ['value'], ['key'])) &&
    Array.isArray(store.indexes) && store.indexes.every(index => record(index) &&
      keys(index, ['name', 'keyPath', 'unique', 'multiEntry']) && text(index.name) &&
      keyPath(index.keyPath) && typeof index.unique === 'boolean' && typeof index.multiEntry === 'boolean'));
}
function valid(value: unknown): value is BrowserState {
  if (!record(value) || !keys(value, ['cookies', 'origins']) ||
      !Array.isArray(value.cookies) || !Array.isArray(value.origins)) return false;
  return value.cookies.every(cookie => record(cookie) &&
    keys(cookie, ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'], ['partitionKey']) &&
    ['name', 'value', 'domain', 'path'].every(key => text(cookie[key])) &&
    typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) && cookie.expires >= -1 &&
    typeof cookie.httpOnly === 'boolean' && typeof cookie.secure === 'boolean' &&
    ['Strict', 'Lax', 'None'].includes(cookie.sameSite as string) &&
    (!Object.hasOwn(cookie, 'partitionKey') || text(cookie.partitionKey))) &&
    value.origins.every(origin => {
      if (!record(origin) || !keys(origin, ['origin', 'localStorage'], ['indexedDB']) ||
          !text(origin.origin) || !Array.isArray(origin.localStorage)) return false;
      try {
        const url = new URL(origin.origin);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin.origin) return false;
      } catch { return false; }
      return origin.localStorage.every(entry => record(entry) && keys(entry, ['name', 'value']) &&
        text(entry.name) && text(entry.value)) &&
        (!Object.hasOwn(origin, 'indexedDB') || (Array.isArray(origin.indexedDB) && origin.indexedDB.every(database)));
    });
}
function parse(bytes: Buffer): BrowserState {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!valid(value)) throw new Error();
  return value;
}
function missing(error: unknown): boolean {
  return record(error) && error.code === 'ENOENT';
}
function safe(stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o077) !== 0 || (!directory && stat.nlink !== 1) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error();
}
function same(a: Stats, b: Stats): void {
  if (a.dev !== b.dev || a.ino !== b.ino) throw new Error();
}

// State contains reusable credentials, not encrypted data. Require a dedicated private
// directory and a trusted parent path: Node's path APIs cannot defeat hostile same-UID
// directory/ancestor swaps. Never log state, paths, or underlying filesystem errors.
export class BrowserStateStore {
  private readonly directory: string;
  private readonly file: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
    this.file = join(this.directory, 'browser-state.json');
  }

  private async directoryStat(create = false): Promise<Stats> {
    if (create) {
      try { await mkdir(this.directory, { mode: 0o700 }); }
      catch (error) { if (!record(error) || error.code !== 'EEXIST') throw error; }
    }
    const stat = await lstat(this.directory);
    safe(stat, true);
    return stat;
  }

  private async fileStat(): Promise<Stats | undefined> {
    try {
      const stat = await lstat(this.file);
      safe(stat, false);
      return stat;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async load(): Promise<{ state: BrowserState | undefined; status: string }> {
    try {
      const directory = await this.directoryStat();
      const stat = await this.fileStat();
      if (!stat) return { state: undefined, status: MISSING };
      const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        safe(opened, false);
        same(stat, opened);
        const buffer = await handle.readFile();
        same(directory, await this.directoryStat());
        const current = await this.fileStat();
        if (!current) throw new Error();
        same(opened, current);
        return { state: parse(buffer), status: 'Saved browser state loaded.' };
      } finally { await handle.close(); }
    } catch (error) {
      return { state: undefined, status: missing(error) ? MISSING : UNAVAILABLE };
    }
  }

  async save(state: BrowserState): Promise<void> {
    let temporary: string | undefined;
    try {
      // Validate the serialized snapshot, not a caller-owned object that can mutate later.
      const bytes = Buffer.from(JSON.stringify(state), 'utf8');
      parse(bytes);
      const directory = await this.directoryStat(true);
      await this.fileStat();
      const candidate = join(this.directory, `.browser-state-${randomUUID()}.tmp`);
      const handle = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporary = candidate;
      try {
        await handle.chmod(0o600);
        await handle.writeFile(bytes);
        await handle.sync();
      } finally { await handle.close(); }
      same(directory, await this.directoryStat());
      await this.fileStat();
      await rename(candidate, this.file);
      temporary = undefined;
    } catch {
      throw new Error(FAILURE);
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    try {
      const directory = await this.directoryStat();
      const stat = await this.fileStat();
      if (!stat) return;
      same(directory, await this.directoryStat());
      await unlink(this.file);
    } catch (error) {
      if (!missing(error)) throw new Error('Unable to clear browser state.');
    }
  }
}
