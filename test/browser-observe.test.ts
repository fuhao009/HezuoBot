import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserSession, browserDefinitions } from '../src/browser.ts';

// In-process mocks only: no Chromium launch, DNS or network.
function fixture() {
  let clicks = 0;
  let reads = 0;
  const page = Object.assign(new EventEmitter(), {
    url: () => 'https://fixture.example/path',
    mainFrame: () => null,
    isClosed: () => false,
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    goBack: async () => ({}),
    goto: async (_url: string, options: { waitUntil: string }) => { assert.equal(options.waitUntil, 'domcontentloaded'); return {}; },
    waitForTimeout: async (_milliseconds: number) => {},
    mouse: { wheel: async (_x: number, _y: number) => {} },
  });
  const session = new BrowserSession({ headless: true });
  const internal = session as unknown as {
    page: typeof page;
    context: unknown;
    starting: Promise<void>;
    trackPage(page: typeof page): void;
    read(signal?: AbortSignal): Promise<string>;
    elements: Map<string, { click(): Promise<void>; fill?(text?: string): Promise<void>; inputValue?(): Promise<string>; dispose(): Promise<void> }>;
    popupTasks: Set<Promise<void>>;
    suspendedActions: Set<Promise<unknown>>;
    dialogWaiters: Set<() => void>;
  };
  Object.assign(internal, { page, starting: Promise.resolve(), context: {
    newCDPSession: async () => ({
      send: async () => ({ currentIndex: 1, entries: [{ url: 'https://8.8.8.8/' }, { url: page.url() }] }),
      detach: async () => {},
    }),
  } });
  internal.trackPage(page);
  internal.elements.set('e0-0', { click: async () => { clicks++; }, dispose: async () => {} });
  internal.read = async () => {
    reads++;
    return JSON.stringify({ untrusted: true, title: 'Fixture', text: 'Ready', elements: [{ id: 'e1-0', role: 'button', label: 'Next' }] });
  };
  return { session, internal, page, counts: () => ({ clicks, reads }) };
}

test('observation schema is explicit, optional and restricted to navigation/click', async () => {
  for (const name of ['browser_open', 'browser_click', 'browser_back']) {
    const schema = browserDefinitions.find(d => d.function.name === name)!.function.parameters;
    assert.deepEqual((schema.properties as Record<string, unknown>).observe, { type: 'string', enum: ['read'] });
    assert.equal((schema.required as readonly string[]).includes('observe'), false);
    assert.equal(schema.additionalProperties, false);
  }
  const session = new BrowserSession();
  for (const observe of [true, false, 'screenshot', null, {}, 1]) {
    assert.equal((await session.execute('browser_click', JSON.stringify({ id: 'e0-0', observe }))).code, 'invalid-arguments');
  }
  assert.equal((await session.execute('browser_read', '{"observe":"read"}')).code, 'invalid-arguments');
  await session.close();
});

test('legacy click does not observe; composite click acts exactly once and returns structure', async () => {
  for (const observe of [undefined, 'read']) {
    const { session, counts } = fixture();
    const result = await session.execute('browser_click', JSON.stringify({ id: 'e0-0', observe }));
    assert.equal(result.ok, true);
    assert.deepEqual(counts(), { clicks: 1, reads: observe ? 1 : 0 });
    if (observe) {
      assert.equal(result.detail?.actionComplete, true);
      assert.equal(result.detail?.refsExpired, false);
      assert.equal(JSON.parse(result.text).untrusted, true);
      assert.equal(JSON.parse(result.text).elements[0].id, 'e1-0');
    }
    await session.close();
  }
});

test('observation failure preserves completed action and never retries', async () => {
  const { session, internal, counts } = fixture();
  internal.read = async () => { throw new Error('private page exception'); };
  const result = await session.execute('browser_click', '{"id":"e0-0","observe":"read"}');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'observation-failed');
  assert.equal(result.detail?.actionComplete, true);
  assert.match(result.text, /Do not repeat/);
  assert.doesNotMatch(result.text, /private page exception/);
  assert.equal(counts().clicks, 1);
  await session.close();
});

test('pre-cancelled request performs neither action nor observation', async () => {
  const { session, counts } = fixture();
  const result = await session.execute('browser_click', '{"id":"e0-0","observe":"read"}', AbortSignal.abort());
  assert.equal(result.code, 'cancelled');
  assert.equal(result.detail?.actionIssued, false);
  assert.deepEqual(counts(), { clicks: 0, reads: 0 });
  await session.close();
});

test('cancellation after click completion skips observation without replay', async () => {
  const { session, internal, counts } = fixture();
  const controller = new AbortController();
  const popup = Promise.withResolvers<void>();
  internal.popupTasks.add(popup.promise);
  const running = session.execute('browser_click', '{"id":"e0-0","observe":"read"}', controller.signal);
  // Let click settle and enter popup-adoption wait before cancellation.
  for (let i = 0; i < 12; i++) await Promise.resolve();
  controller.abort();
  const result = await running;
  assert.equal(result.code, 'cancelled');
  assert.equal(result.detail?.actionComplete, true);
  assert.deepEqual(counts(), { clicks: 1, reads: 0 });
  popup.resolve();
  await popup.promise;
  await session.close();
});

test('cancellation while action is pending retains guard until it settles', async () => {
  const { session, internal, counts } = fixture();
  const pending = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  internal.elements.get('e0-0')!.click = () => {
    started.resolve();
    return pending.promise;
  };
  const controller = new AbortController();
  const running = session.execute('browser_click', '{"id":"e0-0","observe":"read"}', controller.signal);
  await started.promise;
  controller.abort();
  const result = await running;
  assert.equal(result.code, 'cancelled');
  assert.equal(result.detail?.actionIssued, true);
  assert.equal(result.detail?.actionComplete, false);
  assert.equal(internal.suspendedActions.size, 1);
  assert.equal(internal.dialogWaiters.size, 0);
  assert.equal((await session.execute('browser_read', '{}')).code, 'action-pending');
  pending.resolve();
  await pending.promise;
  await Promise.resolve();
  assert.equal(internal.suspendedActions.size, 0);
  assert.equal(counts().reads, 0);
  await session.close();
});

test('composite click waits for popup adoption and observes the resulting active page', async () => {
  const { session, internal } = fixture();
  const adopted = Promise.withResolvers<void>();
  const replacement = { ...internal.page, url: () => 'https://popup.example/' };
  internal.popupTasks.add(adopted.promise);
  internal.read = async () => { assert.equal(internal.page, replacement); return '{"untrusted":true,"elements":[]}'; };
  const running = session.execute('browser_click', '{"id":"e0-0","observe":"read"}');
  internal.page = replacement;
  adopted.resolve();
  assert.equal((await running).ok, true);
  await session.close();
});

test('back with no usable history never observes', async () => {
  const { session, internal, counts } = fixture();
  internal.context = { newCDPSession: async () => ({ send: async () => ({ currentIndex: 0, entries: [] }), detach: async () => {} }) };
  const result = await session.execute('browser_back', '{"observe":"read"}');
  assert.equal(result.code, 'no-history');
  assert.equal(counts().reads, 0);
  await session.close();
});

test('dialog-interrupted click does not observe or replay', async () => {
  const { session, internal, page, counts } = fixture();
  const pending = Promise.withResolvers<void>();
  internal.elements.get('e0-0')!.click = () => {
    page.emit('dialog', { type: () => 'confirm', message: () => 'Submit?', defaultValue: () => '', dismiss: async () => { pending.resolve(); } });
    return pending.promise;
  };
  const result = await session.execute('browser_click', '{"id":"e0-0","observe":"read"}');
  assert.equal(result.code, 'dialog-pending');
  assert.equal(JSON.parse(result.text).actionComplete, false);
  assert.equal(counts().reads, 0);
  await session.close();
});

test('open/back observation reuses the same managed session and page', async () => {
  const { session, internal, page, counts } = fixture();
  for (const [name, args] of [
    ['browser_open', { url: 'https://fixture.example/', observe: 'read' }],
    ['browser_back', { observe: 'read' }],
  ] as const) {
    const result = await session.execute(name, JSON.stringify(args));
    assert.equal(result.ok, true);
    assert.equal(result.detail?.actionComplete, true);
    assert.equal(internal.page, page);
  }
  assert.equal(counts().reads, 2);
  await session.close();
});

test('cancellation during observation returns completed action without observation payload', async () => {
  const { session, internal, counts } = fixture();
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<string>();
  internal.read = async () => { started.resolve(); return pending.promise; };
  const controller = new AbortController();
  const running = session.execute('browser_click', '{"id":"e0-0","observe":"read"}', controller.signal);
  await started.promise;
  controller.abort();
  const result = await running;
  assert.equal(result.code, 'cancelled');
  assert.equal(result.detail?.actionComplete, true);
  assert.equal(result.detail?.observationComplete, false);
  assert.equal(result.image, undefined);
  assert.equal(counts().clicks, 1);
  pending.resolve('{"untrusted":true,"text":"late observation"}');
  await pending.promise;
  await session.close();
});

test('cancelled fill never appends inputValue verification', async () => {
  const { session, internal } = fixture();
  const controller = new AbortController();
  let fills = 0;
  let verifications = 0;
  internal.elements.set('e0-0', {
    click: async () => {},
    fill: async () => { fills++; controller.abort(); },
    inputValue: async () => { verifications++; return 'secret'; },
    dispose: async () => {},
  });
  const result = await session.execute('browser_fill', '{"id":"e0-0","text":"secret"}', controller.signal);
  assert.equal(result.code, 'cancelled');
  assert.equal(result.detail?.actionIssued, true);
  assert.equal(fills, 1);
  assert.equal(verifications, 0);
  await session.close();
});

test('scroll and explicit wait stop waiting on cancellation without appending reads', async () => {
  for (const name of ['browser_scroll', 'browser_wait']) {
    const { session, internal, page, counts } = fixture();
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    page.mouse.wheel = async () => { entered.resolve(); await pending.promise; };
    page.waitForTimeout = async () => { entered.resolve(); await pending.promise; };
    const controller = new AbortController();
    const running = session.execute(name, name === 'browser_scroll' ? '{"pixels":100}' : '{"milliseconds":100}', controller.signal);
    await entered.promise;
    controller.abort();
    const result = await running;
    assert.equal(result.code, 'cancelled');
    assert.equal(internal.suspendedActions.size, 1);
    assert.equal(internal.dialogWaiters.size, 0);
    assert.equal(counts().reads, 0);
    pending.resolve();
    await pending.promise;
    await session.close();
  }
});

test('switch cancelled during URL validation leaves active page unchanged', async () => {
  const { session, internal, page } = fixture();
  const controller = new AbortController();
  const target = Object.assign(new EventEmitter(), {
    mainFrame: page.mainFrame,
    isClosed: page.isClosed,
    setDefaultTimeout: page.setDefaultTimeout,
    setDefaultNavigationTimeout: page.setDefaultNavigationTimeout,
    goBack: page.goBack,
    goto: page.goto,
    waitForTimeout: page.waitForTimeout,
    mouse: page.mouse,
    url: () => { controller.abort(); return 'https://target.example/'; },
  });
  internal.trackPage(target);
  const result = await session.execute('browser_switch', '{"tab":"t2"}', controller.signal);
  assert.equal(result.code, 'cancelled');
  assert.equal(result.detail?.actionIssued, false);
  assert.equal(internal.page, page);
  await session.close();
});
