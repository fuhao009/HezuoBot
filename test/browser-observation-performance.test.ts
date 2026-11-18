import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession, type BrowserPageState, type BrowserResult } from '../src/browser.ts';

// Execute the serialization callbacks, not a canned approximation of their output.
function withGlobals<T>(values: Record<string, unknown>, run: () => T): T {
  const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    return run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function fixture() {
  const session = new BrowserSession({ headless: true });
  const counts = { evaluate: 0, title: 0, read: 0, wait: 0, disposed: 0, actions: 0 };
  const metrics = { title: 'Snapshot', readyState: 'complete', viewport: { width: 960, height: 640 }, scroll: { x: 12, y: 480 } };
  const page = {
    url: () => 'https://fixture.test/path',
    isClosed: () => false,
    viewportSize: () => ({ width: 800, height: 600 }),
    title: async () => { counts.title++; return 'Fallback'; },
    evaluate: async (callback: () => unknown): Promise<unknown> => {
      counts.evaluate++;
      return withGlobals({ document: { title: metrics.title, readyState: metrics.readyState }, innerWidth: 960, innerHeight: 640, scrollX: 12, scrollY: 480 }, callback);
    },
    waitForFunction: async () => {
      counts.wait++;
      return { dispose: async () => { counts.disposed++; } };
    },
    click: async () => { counts.actions++; },
    fill: async () => { counts.actions++; },
    goto: async () => { counts.actions++; },
    reload: async () => { counts.actions++; },
  };
  Object.assign(session, { page, starting: Promise.resolve(), tabs: new Map([['t1', page]]) });
  Object.assign(session, { read: async () => { counts.read++; return JSON.stringify({ untrusted: true, text: 'Ready', elements: [] }); } });
  const state = (signal?: AbortSignal): Promise<BrowserPageState> => Reflect.apply(Reflect.get(session, 'pageState'), session, [page, signal]);
  const wait = (signal?: AbortSignal) => session.execute('browser_wait_for', JSON.stringify({ text: 'Ready', observe: 'read' }), signal);
  return { session, page, counts, metrics, state, wait };
}

function stateOf(result: BrowserResult): BrowserPageState {
  assert.ok(result.detail?.state);
  return result.detail.state as BrowserPageState;
}

function pending(session: BrowserSession, page: unknown) {
  const dialogs: Map<string, unknown> = Reflect.get(session, 'dialogs');
  dialogs.set('d1', { page, dialog: { type: () => 'alert', message: () => 'Confirm', defaultValue: () => '' } });
}

test('read executes exactly one evaluate per output element, retaining labels, values and UTF-16 constraints', async () => {
  const { session, page } = fixture();
  const specifications = [
    { tagName: 'INPUT', attrs: { 'aria-label': '  Account\n name ' }, value: 'A😀', maxLength: 3, required: true, readOnly: false, disabled: true },
    { tagName: 'TEXTAREA', attrs: { placeholder: ' Notes ' }, value: '😀\nB', maxLength: -1, required: false, readOnly: true, disabled: false },
    { tagName: 'BUTTON', attrs: { role: 'tab' }, innerText: ' Next\n step ', textContent: 'ignored' },
    { tagName: 'SPAN', attrs: {}, textContent: ' Plain\t label ' },
  ];
  const calls = specifications.map(() => 0);
  let candidateDisposals = 0;
  const handles = specifications.map((specification, index) => ({
    asElement() { return this; },
    isVisible: async () => true,
    dispose: async () => {},
    evaluate: async (callback: (element: Element) => unknown) => {
      calls[index]++;
      const node = { ...specification, getAttribute: (name: string) => Reflect.get(specification.attrs, name) ?? null };
      return callback(node as unknown as Element);
    },
  }));
  Object.assign(page, {
    evaluateHandle: async () => ({ getProperties: async () => new Map(handles.map((handle, index) => [String(index), handle])), dispose: async () => { candidateDisposals++; } }),
    locator: () => ({ evaluate: async () => 'Visible text' }),
  });
  // Restore the real implementation instead of fixture's custom read.
  Reflect.deleteProperty(session, 'read');
  const raw: string = await Reflect.apply(Reflect.get(session, 'read'), session, []);
  const output = JSON.parse(raw) as { elements: Record<string, unknown>[]; elementsTotal: number; elementsTruncated: boolean };
  assert.deepEqual(calls, [1, 1, 1, 1]);
  assert.equal(candidateDisposals, 1);
  assert.equal(output.elementsTotal, 4);
  assert.equal(output.elementsTruncated, false);
  const { elements } = output;
  assert.deepEqual(elements.map(({ id, ...info }) => { assert.match(String(id), /^e\d+-\d+$/); return info; }), [
    { role: 'input', label: 'Account name', value: 'A😀', constraints: { maxLength: 3, lengthUnits: 'UTF-16', required: true, readOnly: false, disabled: true } },
    { role: 'textarea', label: 'Notes', value: '😀\nB', constraints: { maxLength: null, lengthUnits: 'UTF-16', required: false, readOnly: true, disabled: false } },
    { role: 'tab', label: 'Next step', constraints: { maxLength: null, lengthUnits: 'UTF-16' } },
    { role: 'span', label: 'Plain label', constraints: { maxLength: null, lengthUnits: 'UTF-16' } },
  ]);
  assert.equal('A😀'.length, 3);
  assert.equal(Object.hasOwn(elements[2]!, 'value'), false);
});

test('pageState samples title, readyState, viewport and scroll in one evaluate, including empty title', async () => {
  for (const title of ['Snapshot', '']) {
    const f = fixture();
    f.metrics.title = title;
    const state = await f.state();
    assert.deepEqual({ title: state.title, readyState: state.readyState, viewport: state.viewport, scroll: state.scroll }, f.metrics);
    assert.equal(f.counts.evaluate, 1);
    assert.equal(f.counts.title, 0);
    assert.equal(state.untrusted, true);
    assert.equal(state.url, f.page.url());
  }
});

test('pageState falls back only when evaluation fails or omits title, retaining available metrics', async () => {
  for (const fails of [false, true]) {
    const f = fixture();
    f.page.evaluate = async () => {
      f.counts.evaluate++;
      if (fails) throw new Error('navigation');
      return { readyState: 'interactive', viewport: { width: 123, height: 456 }, scroll: { x: 1, y: 2 } };
    };
    const state = await f.state();
    assert.equal(f.counts.evaluate, 1);
    assert.equal(f.counts.title, 1);
    assert.equal(state.title, 'Fallback');
    assert.equal(state.readyState, fails ? null : 'interactive');
    assert.deepEqual(state.viewport, fails ? { width: 800, height: 600 } : { width: 123, height: 456 });
    assert.deepEqual(state.scroll, fails ? null : { x: 1, y: 2 });
  }
  const f = fixture();
  f.page.evaluate = async () => { throw new Error('unavailable'); };
  f.page.title = async () => { throw new Error('unavailable'); };
  assert.equal((await f.state()).title, null);
});

test('pageState does not swallow abort or perform title fallback after an aborted evaluate', async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error('stop');
  f.page.evaluate = async () => { f.counts.evaluate++; controller.abort(reason); throw new Error('navigation'); };
  await assert.rejects(f.state(controller.signal), error => error === reason);
  assert.equal(f.counts.evaluate, 1);
  assert.equal(f.counts.title, 0);
  await assert.rejects(f.state(controller.signal), error => error === reason);
  assert.equal(f.counts.evaluate, 1);
});

test('wait_for observe read reuses its sole state snapshot and does not replay actions', async () => {
  const f = fixture();
  const result = await f.wait();
  assert.equal(result.ok, true);
  const observation: { state: BrowserPageState } = JSON.parse(result.text.slice(result.text.indexOf('{')));
  assert.deepEqual(stateOf(result), observation.state);
  assert.equal(result.detail?.conditionObserved, true);
  assert.equal(result.detail?.observation, 'read');
  assert.equal(f.counts.read, 1);
  assert.equal(f.counts.evaluate, 1);
  assert.equal(f.counts.title, 0);
  assert.equal(f.counts.wait, 1);
  assert.equal(f.counts.disposed, 1);
  assert.equal(f.counts.actions, 0);
});

test('wait_for read failure is diagnostic, never success, and diagnostic failure preserves the original code', async () => {
  for (const diagnosticsFail of [false, true]) {
    const f = fixture();
    Object.assign(f.session, { read: async () => { f.counts.read++; throw new Error('element detached: private-value'); } });
    if (diagnosticsFail) Object.assign(f.session, { pageState: async () => { f.counts.evaluate++; throw new Error('Timeout diagnostic'); } });
    const result = await f.wait();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'stale-ref');
    assert.equal(result.detail?.conditionObserved, true);
    assert.equal(result.detail?.observation, 'read');
    assert.match(result.text, /read failed.*stale-ref/);
    assert.doesNotMatch(result.text, /private-value|Timeout diagnostic/);
    if (diagnosticsFail) assert.equal(result.detail?.state, null);
    else assert.equal(stateOf(result).title, 'Snapshot');
    assert.equal(f.counts.evaluate, 1);
    assert.equal(f.counts.read, 1);
    assert.equal(f.counts.wait, 1);
    assert.equal(f.counts.actions, 0);
  }
});

test('custom read without detail.state gets one fallback snapshot without changing read.ok', async () => {
  for (const ok of [false, true]) {
    const f = fixture();
    Object.assign(f.session, { observedRead: async (): Promise<BrowserResult> => { f.counts.read++; return { ok, code: ok ? undefined : 'custom-failure', text: 'custom observation' }; } });
    const result = await f.wait();
    assert.equal(result.ok, ok);
    assert.equal(result.code, ok ? undefined : 'custom-failure');
    assert.equal(stateOf(result).title, 'Snapshot');
    assert.equal(f.counts.evaluate, 1);
    assert.equal(f.counts.read, 1);
    assert.equal(f.counts.wait, 1);
    assert.equal(f.counts.actions, 0);
  }
});

test('pending dialog after condition/read keeps the pending contract without sampling or replay', async () => {
  const f = fixture();
  Object.assign(f.session, { read: async () => { f.counts.read++; pending(f.session, f.page); throw new Error('dialog pending'); } });
  const result = await f.wait();
  assert.equal(result.ok, true);
  assert.equal(result.code, 'dialog-pending');
  assert.equal(f.counts.evaluate, 0);
  assert.equal(f.counts.title, 0);
  assert.equal(f.counts.read, 1);
  assert.equal(f.counts.wait, 1);
  assert.equal(f.counts.actions, 0);
});

test('abort during a pending read uses Promise signals, skips diagnostics and never replays actions', async () => {
  const f = fixture();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<string>();
  Object.assign(f.session, { read: () => { f.counts.read++; entered.resolve(); return reading.promise; } });
  const waiting = f.wait(controller.signal);
  await entered.promise;
  controller.abort();
  const result = await waiting;
  reading.resolve('{}');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cancelled');
  assert.equal(f.counts.evaluate, 0);
  assert.equal(f.counts.title, 0);
  assert.equal(f.counts.read, 1);
  assert.equal(f.counts.wait, 1);
  assert.equal(f.counts.actions, 0);
});
