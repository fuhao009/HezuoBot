import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium, type Browser } from 'playwright';
import { BrowserSession, browserDefinitions } from '../src/browser.ts';

// No browser process or network is needed for lifecycle/dialog regressions.
function fixture() {
  const page = Object.assign(new EventEmitter(), {
    url: () => 'https://fixture.example/path',
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    mainFrame: () => null,
    isClosed: () => false,
  });
  const session = new BrowserSession({ headless: true });
  // Test seam exposes only private state exercised by these in-process mocks.
  const internal = session as unknown as {
    trackPage(page: EventEmitter): void;
    elements: Map<string, { click(): Promise<void>; dispose(): Promise<void> }>;
    busy: boolean;
    suspendedActions: Set<Promise<unknown>>;
    dialogWaiters: Set<() => void>;
  };
  Object.assign(internal, { page, starting: Promise.resolve() });
  internal.trackPage(page);
  return { page, session, internal, run: (name: string, args = {}) => session.execute(name, JSON.stringify(args)) };
}
function dialog(type = 'confirm', message = 'Continue?') {
  const calls: unknown[] = [];
  return { calls, type: () => type, message: () => message, defaultValue: () => 'initial',
    accept: async (text?: string) => { calls.push(['accept', text]); },
    dismiss: async () => { calls.push(['dismiss']); } };
}

test('dialog definitions use explicit IDs and reject invalid arguments before startup', async () => {
  for (const name of ['browser_dialogs', 'browser_dialog_accept', 'browser_dialog_dismiss']) {
    assert(browserDefinitions.some(d => d.function.name === name));
  }
  const session = new BrowserSession();
  for (const args of [{}, { dialog: 'bad' }, { dialog: 'd1', extra: true }, { dialog: 'd1', text: 3 }]) {
    assert.equal((await session.execute('browser_dialog_accept', JSON.stringify(args))).code, 'invalid-arguments');
  }
  await session.close();
});

test('confirm remains observable, blocks normal actions and resolves only explicitly', async () => {
  const { page, session, run } = fixture();
  const confirm = dialog();
  page.emit('dialog', confirm);
  assert.deepEqual(confirm.calls, []);
  const result = await run('browser_read');
  assert.equal(result.code, 'dialog-pending');
  const pending = JSON.parse(result.text);
  assert.equal(pending.untrusted, true);
  assert.equal(pending.actionComplete, false);
  assert.equal(pending.dialogs[0].origin, 'https://fixture.example');
  assert.equal(pending.dialogs[0].message, 'Continue?');
  assert.equal((await run('browser_dialog_accept', { dialog: 'd1', text: 'invalid for confirm' })).code, 'invalid-arguments');
  assert.deepEqual(confirm.calls, []);
  assert.equal((await run('browser_dialog_dismiss', { dialog: 'd1' })).ok, true);
  assert.deepEqual(confirm.calls, [['dismiss']]);
  assert.equal((await run('browser_dialog_accept', { dialog: 'd1' })).code, 'stale-dialog');
  assert.deepEqual(JSON.parse((await run('browser_dialogs')).text).dialogs, []);
  await session.close();
});

test('prompt accepts explicit text; alert is auto accepted; closed tabs forget dialogs', async () => {
  const { page, session, run } = fixture();
  const prompt = dialog('prompt');
  page.emit('dialog', prompt);
  assert.equal(JSON.parse((await run('browser_dialogs')).text).dialogs[0].defaultValue, 'initial');
  assert.equal((await run('browser_dialog_accept', { dialog: 'd1', text: 'chosen value' })).ok, true);
  assert.deepEqual(prompt.calls, [['accept', 'chosen value']]);
  const alert = dialog('alert');
  page.emit('dialog', alert);
  assert.deepEqual(alert.calls, [['accept', undefined]]);
  const unload = dialog('beforeunload');
  page.emit('dialog', unload);
  assert.deepEqual(unload.calls, []);
  page.emit('close');
  assert.equal((await run('browser_dialog_dismiss', { dialog: 'd2' })).code, 'stale-dialog');
  await session.close();
});

test('click returns pending instead of deadlocking, then explicit acceptance resumes it', async () => {
  const { page, session, internal, run } = fixture();
  const complete = Promise.withResolvers<void>();
  const confirm = dialog();
  confirm.accept = async () => { confirm.calls.push(['accept']); complete.resolve(); };
  internal.elements.set('e0-1', {
    click: () => { queueMicrotask(() => page.emit('dialog', confirm)); return complete.promise; },
    dispose: async () => {},
  });
  assert.equal((await run('browser_click', { id: 'e0-1' })).code, 'dialog-pending');
  assert.equal(internal.busy, false);
  assert.equal((await run('browser_dialog_accept', { dialog: 'd1' })).ok, true);
  assert.equal(internal.suspendedActions.size, 0);
  assert.equal(internal.dialogWaiters.size, 0);
  await session.close();
});

test('successive dialogs during one action remain pending after first acceptance', async () => {
  const { page, session, internal, run } = fixture();
  const complete = Promise.withResolvers<void>();
  const first = dialog();
  const second = dialog('prompt');
  first.accept = async () => { queueMicrotask(() => page.emit('dialog', second)); };
  second.dismiss = async () => { complete.resolve(); };
  internal.elements.set('e0-1', {
    click: () => { queueMicrotask(() => page.emit('dialog', first)); return complete.promise; },
    dispose: async () => {},
  });
  assert.equal((await run('browser_click', { id: 'e0-1' })).code, 'dialog-pending');
  const result = await run('browser_dialog_accept', { dialog: 'd1' });
  assert.equal(result.code, 'dialog-pending');
  assert.equal(JSON.parse(result.text).dialogs[0].type, 'prompt');
  assert.equal((await run('browser_dialog_dismiss', { dialog: 'd2' })).ok, true);
  await session.close();
});

test('failed automatic startup is actionable, sanitized, and retryable', async t => {
  let launches = 0;
  t.mock.method(chromium, 'launch', async () => { launches++; throw new Error('PRIVATE launch detail'); });
  const session = new BrowserSession();
  for (let i = 0; i < 2; i++) {
    const result = await session.execute('browser_tabs', '{}');
    assert.equal(result.code, 'startup-failed');
    assert.match(result.text, /npx playwright install chromium/);
    assert.match(result.text, /No user desktop fallback/);
    assert(!result.text.includes('PRIVATE'));
  }
  assert.equal(launches, 2);
  await session.close();
});

test('managed startup is lazy and a successfully started context is reused', async t => {
  let launches = 0;
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    url: () => 'about:blank',
  });
  const context = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    newPage: async () => page,
  });
  t.mock.method(chromium, 'launch', async () => {
    launches++;
    // Only newContext/close are used in this lifecycle fixture.
    const browser = { newContext: async () => context, close: async () => {} } as unknown as Browser;
    return browser;
  });
  const session = new BrowserSession();
  assert.equal(launches, 0);
  assert.equal((await session.execute('browser_tabs', '{}')).ok, true);
  assert.equal((await session.execute('browser_tabs', '{}')).ok, true);
  assert.equal(launches, 1);
  await session.close();
});

test('dialog resolution does not hang on unfinished action or permit conflicting actions', async () => {
  const { page, session, internal, run } = fixture();
  const complete = Promise.withResolvers<void>();
  const confirm = dialog();
  internal.elements.set('e0-1', {
    click: () => { queueMicrotask(() => page.emit('dialog', confirm)); return complete.promise; },
    dispose: async () => {},
  });
  assert.equal((await run('browser_click', { id: 'e0-1' })).code, 'dialog-pending');
  assert.equal((await session.saveState()).code, 'dialog-pending');
  assert.equal((await session.resumeAccess()).code, 'dialog-pending');
  assert.equal((await session.loginLocal('{}', undefined, new AbortController().signal)).code, 'dialog-pending');
  assert.equal((await run('browser_dialog_accept', { dialog: 'd1' })).code, 'action-pending');
  assert.equal((await run('browser_read')).code, 'action-pending');
  assert.equal((await run('browser_tabs')).ok, true);
  complete.resolve();
  await complete.promise;
  await session.close();
});

test('dialog handling failures are not disguised as successful pending results', async () => {
  const { page, session, run } = fixture();
  const confirm = dialog();
  confirm.accept = async () => { throw new Error('PRIVATE failure'); };
  page.emit('dialog', confirm);
  const result = await run('browser_dialog_accept', { dialog: 'd1' });
  assert.equal(result.ok, false);
  assert(!result.text.includes('PRIVATE'));
  assert.equal(JSON.parse((await run('browser_dialogs')).text).dialogs.length, 1);
  await session.close();
});

test('dialogs raised while closing are dismissed rather than abandoned', async () => {
  const { page, session } = fixture();
  const second = dialog('prompt');
  const first = dialog();
  first.dismiss = async () => { page.emit('dialog', second); };
  page.emit('dialog', first);
  await session.close();
  assert.deepEqual(second.calls, [['dismiss']]);
});

test('partial initialization failure closes its browser and allows a clean retry', async t => {
  let attempts = 0;
  let closes = 0;
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'about:blank',
  });
  const context = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, newPage: async () => page,
  });
  t.mock.method(chromium, 'launch', async () => {
    const attempt = ++attempts;
    // Minimal browser fixture for the two initialization attempts.
    const browser = {
      newContext: async () => { if (attempt === 1) throw new Error('initialization failed'); return context; },
      close: async () => { closes++; },
    } as unknown as Browser;
    return browser;
  });
  const session = new BrowserSession();
  assert.equal((await session.execute('browser_tabs', '{}')).code, 'startup-failed');
  assert.equal(closes, 1);
  assert.equal((await session.execute('browser_tabs', '{}')).ok, true);
  assert.equal(attempts, 2);
  await session.close();
  assert.equal(closes, 2);
});
