import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession, browserDefinitions, browserToolNames } from '../src/browser.ts';

function setup(wait: (predicate: Function, arg: unknown, options: { timeout: number }) => Promise<unknown>) {
  const session = new BrowserSession({ headless: true });
  const page = {
    url: () => 'https://example.test/path?x=1',
    isClosed: () => false,
    waitForFunction: async (predicate: Function, arg: unknown, options: { timeout: number }) => {
      const result = await wait(predicate, arg, options);
      if (result && typeof result === 'object' && 'jsonValue' in result && 'dispose' in result) return result;
      return { jsonValue: async () => true, dispose: async () => {} };
    },
    title: async () => 'Fixture',
    evaluate: async () => ({ readyState: 'complete', viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0 } }),
    viewportSize: () => ({ width: 800, height: 600 }),
  };
  Object.assign(session, { page, starting: Promise.resolve(), tabs: new Map([['t1', page]]), elements: new Map() });
  return session;
}

test('browser_wait_for exports a constrained condition tool; legacy wait remains exported', () => {
  assert(browserToolNames.includes('browser_wait'));
  assert(browserToolNames.includes('browser_wait_for'));
  const definition = browserDefinitions.find(d => d.function.name === 'browser_wait_for')!;
  assert.equal(definition.function.parameters.additionalProperties, false);
  assert.match(definition.function.description, /all \(AND\).*any \(OR\)/);
  assert.match(definition.function.description, /visible document innerText/);
});

test('URL and visible text both passed as safe serializable conditions with all relation', async () => {
  let called = false;
  const session = setup(async (predicate, arg, options) => {
    called = true;
    const data = arg as { conditions: { type: string; value: string; match: string }[]; relation: string };
    assert.match(predicate.toString(), /location\.href/);
    assert.match(predicate.toString(), /innerText/);
    assert.equal(data.relation, 'all');
    assert.deepEqual(data.conditions.map(c => [c.type, c.value, c.match]), [['url', '/path', 'includes'], ['text', 'Ready', 'exact']]);
    const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://example.test/path?x=1' } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { innerText: 'Ready' } } });
    try { assert.equal(predicate(data), true); }
    finally {
      if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else Reflect.deleteProperty(globalThis, 'location');
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
    }
    return { jsonValue: async () => true, dispose: async () => {} };
  });
  const result = await session.execute('browser_wait_for', JSON.stringify({ url: '/path', text: 'Ready', text_match: 'exact', timeout_ms: 250 }));
  assert(called);
  assert.equal(result.ok, true);
  assert.equal(result.detail?.conditionObserved, true);
  assert.match(result.text, /no business completion/);
  await session.close();
});

test('matched condition with failed optional read remains a read failure', async () => {
  const session = setup(async () => ({}));
  Object.assign(session, { read: async () => { throw new Error('mock read failure'); } });
  const result = await session.execute('browser_wait_for', JSON.stringify({ text: 'Visible', observe: 'read' }));
  assert.equal(result.ok, false);
  assert.equal(result.detail?.conditionObserved, true);
  assert.match(result.text, /optional page read failed/);
  await session.close();
});

test('pending dialog during condition wait returns pending, not observed success', async () => {
  let session: BrowserSession;
  let calls = 0;
  const page = { url: () => 'https://example.test/path?x=1', isClosed: () => false, waitForFunction: async (_predicate: Function, _arg: unknown, options: { timeout: number }) => {
    calls++;
    if (calls === 1) throw new Error(`Timeout ${options.timeout}ms exceeded`);
    const dialog = { type: () => 'alert', message: () => 'fixture', defaultValue: () => '', dismiss: async () => {} };
    Object.assign(session, { dialogs: new Map([['d1', { page, dialog }]]) });
    return { dispose: async () => {} };
  }, title: async () => 'Fixture', evaluate: async () => ({ readyState: 'complete', viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0 } }), viewportSize: () => ({ width: 800, height: 600 }) };
  session = new BrowserSession({ headless: true });
  Object.assign(session, { page, starting: Promise.resolve(), tabs: new Map([['t1', page]]), elements: new Map() });
  const result = await session.execute('browser_wait_for', JSON.stringify({ text: 'Visible', observe: 'read', timeout_ms: 1000 }));
  assert.equal(result.ok, true); // Pending metadata is readable; it is not action completion.
  assert.equal(result.code, 'dialog-pending');
  assert.equal(result.detail?.actionComplete, false);
  assert.notEqual(result.detail?.conditionObserved, true);
  await session.close();
});

test('dialog during optional read remains pending without claiming the condition completed the goal', async () => {
  const session = setup(async () => ({}));
  const page = Reflect.get(session, 'page');
  Object.assign(session, { read: async () => {
    const dialog = { type: () => 'alert', message: () => 'fixture', defaultValue: () => '', dismiss: async () => {} };
    Object.assign(session, { dialogs: new Map([['d1', { page, dialog }]]) });
    throw new Error('dialog pending');
  } });
  try {
    const result = await session.execute('browser_wait_for', JSON.stringify({ text: 'Visible', observe: 'read' }));
    assert.equal(result.code, 'dialog-pending');
    assert.equal(result.detail?.actionComplete, false);
    assert.notEqual(result.detail?.conditionObserved, true);
  } finally { await session.close(); }
});

test('any relation is serialized and caller timeout is reported unobserved', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  let predicateSeen = false;
  const session = setup(async (_predicate, arg, options) => {
    assert(options.timeout > 0 && options.timeout <= 100);
    const data = arg as { conditions: unknown[]; relation: string };
    assert.equal(data.relation, 'any');
    predicateSeen = true;
    now += options.timeout;
    throw new Error(`Timeout ${options.timeout}ms exceeded`);
  });
  const result = await session.execute('browser_wait_for', JSON.stringify({ text: 'Never', condition: 'any', timeout_ms: 1 }));
  assert(predicateSeen);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'condition-timeout');
  assert.equal(result.detail?.conditionObserved, false);
  await session.close();
});

test('invalid or missing conditions rejected before page wait', async () => {
  let called = false;
  const session = setup(async () => { called = true; return {}; });
  assert.equal((await session.execute('browser_wait_for', '{}')).code, 'invalid-arguments');
  assert.equal((await session.execute('browser_wait_for', JSON.stringify({ text: 'x', text_match: 'regex' }))).code, 'invalid-arguments');
  assert.equal((await session.execute('browser_wait_for', JSON.stringify({ url: 'x', timeout_ms: -1 }))).code, 'invalid-arguments');
  assert.equal(called, false);
  await session.close();
});

test('abort interrupts condition wait and later browser call can proceed', async () => {
  const { promise: firstWait, reject: settleFirstWait } = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<void>();
  let attempts = 0;
  const session = setup(async (_predicate, _arg, { timeout }) => {
    attempts++;
    if (attempts === 1) {
      assert.equal(timeout, 100);
      started.resolve();
      return firstWait;
    }
    assert.equal(timeout, 100);
    return { jsonValue: async () => true, dispose: async () => {} };
  });
  const controller = new AbortController();
  const pending = session.execute('browser_wait_for', JSON.stringify({ text: 'Later' }), controller.signal);
  await started.promise;
  controller.abort();
  settleFirstWait(new Error('Timeout 100ms exceeded'));
  const result = await pending;
  assert.equal(result.code, 'cancelled');
  const next = await session.execute('browser_wait_for', JSON.stringify({ text: 'Next' }));
  assert.equal(next.ok, true);
  assert.equal(attempts, 2);
  await session.close();
});
