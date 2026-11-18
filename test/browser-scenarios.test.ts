import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserSession, browserDefinitions, type BrowserResult, type BrowserPageState } from '../src/browser.ts';

// These fixtures exercise the managed-session contract without launching Chromium,
// resolving a hostname, contacting a site or mocking a successful browser startup.
function fixture() {
  let url = 'https://fixture.example/start';
  let viewport = { width: 960, height: 640 };
  const counts = { goto: 0, clicks: 0, fills: 0, reads: 0, evaluations: 0, screenshots: 0, viewportWrites: 0, reloads: 0 };
  const response = { status: () => 200 };
  const page = Object.assign(new EventEmitter(), {
    url: () => url,
    title: async () => 'Fixture page',
    mainFrame: (): { url(): string } | null => null,
    isClosed: () => false,
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    viewportSize: () => ({ ...viewport }),
    setViewportSize: async (size: { width: number; height: number }) => {
      counts.viewportWrites++;
      viewport = { ...size };
    },
    evaluate: async (_fn: unknown) => {
      counts.evaluations++;
      return { readyState: 'complete', viewport: { ...viewport }, scroll: { x: 12, y: 480 } };
    },
    goto: async (target: string, options: { waitUntil: string }): Promise<{ status(): number } | null> => {
      counts.goto++;
      assert.equal(options.waitUntil, 'domcontentloaded');
      url = target;
      return response;
    },
    reload: async () => { counts.reloads++; return response; },
    screenshot: async (options: { fullPage?: boolean }) => {
      counts.screenshots++;
      assert.equal(options.fullPage, false);
      return Buffer.from('mock-jpeg');
    },
  });
  const session = new BrowserSession({ headless: true });
  const internal = session as unknown as {
    page: typeof page;
    context: unknown;
    starting: Promise<void>;
    trackPage(page: typeof page): void;
    read(signal?: AbortSignal): Promise<string>;
    elements: Map<string, { click(): Promise<void>; fill(text: string): Promise<void>; inputValue(): Promise<string>; dispose(): Promise<void> }>;
    suspendedActions: Set<Promise<unknown>>;
  };
  Object.assign(internal, { page, context: {}, starting: Promise.resolve() });
  internal.trackPage(page);
  const element = {
    click: async () => { counts.clicks++; },
    fill: async (_text: string) => { counts.fills++; },
    inputValue: async () => 'fixture-value',
    dispose: async () => {},
  };
  internal.elements.set('e0-0', element);
  internal.read = async () => {
    counts.reads++;
    return JSON.stringify({ untrusted: true, title: 'Fixture page', text: 'Visible text', elements: [{ id: 'e1-0', role: 'button', label: 'Next' }] });
  };
  return { session, internal, page, response, counts, element, setUrl: (value: string) => { url = value; } };
}

function stateOf(result: BrowserResult) {
  assert.ok(result.detail?.state, 'structured state must be available independently of legacy text');
  return result.detail.state as BrowserPageState;
}

test('observe and viewport are explicitly exported tool contracts', () => {
  const observe = browserDefinitions.find(d => d.function.name === 'browser_observe');
  const viewport = browserDefinitions.find(d => d.function.name === 'browser_viewport');
  assert.ok(observe);
  assert.ok(viewport);
  assert.equal(observe.function.parameters.additionalProperties, false);
  assert.deepEqual(observe.function.parameters.required, []);
  const props = viewport.function.parameters.properties as Record<string, unknown>;
  assert.ok(props.width);
  assert.ok(props.height);
});

test('observe reuses one structural read and exposes actual view metadata without losing legacy text', async () => {
  const { session, counts } = fixture();
  try {
    const result = await session.execute('browser_observe', '{}');
    assert.equal(result.ok, true);
    assert.equal(counts.reads, 1);
    assert.equal(counts.goto, 0);
    const text = JSON.parse(result.text);
    assert.equal(text.untrusted, true);
    assert.equal(text.text, 'Visible text');
    assert.equal(text.elements[0].id, 'e1-0');
    const state = stateOf(result);
    assert.equal(state.url, 'https://fixture.example/start');
    assert.equal(state.title, 'Fixture page');
    assert.equal(state.readyState, 'complete');
    assert.equal(state.httpStatus, null);
    assert.deepEqual(state.viewport, { width: 960, height: 640 });
    assert.deepEqual(state.scroll, { x: 12, y: 480 });
    assert.deepEqual(state.dialogs, []);
    assert.equal(state.pageError, null);
    assert.deepEqual(text.state, state);
  } finally { await session.close(); }
});

test('legacy browser_read includes the same structured state', async () => {
  const { session, counts } = fixture();
  try {
    const result = await session.execute('browser_read', '{}');
    assert.equal(result.ok, true);
    assert.equal(counts.reads, 1);
    assert.deepEqual(JSON.parse(result.text).state, stateOf(result));
  } finally { await session.close(); }
});

for (const status of [404, 502]) {
  test(`HTTP ${status} is diagnosed with state and structure, not refreshed or replayed`, async () => {
    const { session, response, counts } = fixture();
    response.status = () => status;
    try {
      const result = await session.execute('browser_open', JSON.stringify({ url: 'https://fixture.example/error', observe: 'read' }));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'http-error');
      assert.equal(result.detail?.actionComplete, true);
      assert.equal(stateOf(result).httpStatus, status);
      assert.deepEqual(stateOf(result).pageError, { type: 'http', status });
      assert.equal(stateOf(result).url, 'https://fixture.example/error');
      assert.equal(JSON.parse(result.text).untrusted, true);
      assert.equal(counts.goto, 1);
      assert.equal(counts.reads, 1);
      assert.equal(counts.reloads, 0);
      const observed = await session.execute('browser_observe', '{}');
      assert.equal(stateOf(observed).httpStatus, status);
      assert.equal(counts.goto, 1);
      assert.equal(counts.reloads, 0);
    } finally { await session.close(); }
  });
}

test('viewport preparation reads and sets only the managed viewport, shared with screenshots', async () => {
  const { session, internal, counts } = fixture();
  try {
    const initial = await session.execute('browser_viewport', '{}');
    assert.deepEqual(stateOf(initial).viewport, { width: 960, height: 640 });
    assert.equal(counts.viewportWrites, 0);
    const resized = await session.execute('browser_viewport', '{"width":1280,"height":720}');
    assert.equal(resized.ok, true);
    assert.deepEqual(stateOf(resized).viewport, { width: 1280, height: 720 });
    assert.equal(counts.viewportWrites, 1);
    assert.equal(internal.elements.size, 0, 'resizing invalidates coordinate-dependent element refs');
    const screenshot = await session.execute('browser_screenshot', '{}');
    assert.equal(screenshot.ok, true);
    assert.ok(screenshot.image);
    assert.deepEqual(stateOf(screenshot).viewport, { width: 1280, height: 720 });
    assert.deepEqual(stateOf(screenshot).scroll, { x: 12, y: 480 });
    assert.equal(counts.screenshots, 1);
    assert.equal(counts.goto, 0);
  } finally { await session.close(); }
});

test('invalid viewport sizes are rejected without resizing or navigation', async () => {
  const { session, counts } = fixture();
  try {
    for (const args of [{ width: 1280 }, { height: 720 }, { width: 0, height: 1 }, { width: 1.5, height: 2 }, { width: 2, height: -1 }, { width: '1280', height: 720 }]) {
      const result = await session.execute('browser_viewport', JSON.stringify(args));
      assert.equal(result.code, 'invalid-arguments');
    }
    assert.equal(counts.viewportWrites, 0);
    assert.equal(counts.goto, 0);
  } finally { await session.close(); }
});

test('pre-cancellation appends no action, observation or viewport mutation', async () => {
  const { session, counts } = fixture();
  try {
    const signal = AbortSignal.abort();
    for (const [name, args] of [
      ['browser_open', '{"url":"https://fixture.example/next","observe":"read"}'],
      ['browser_click', '{"id":"e0-0","observe":"read"}'],
      ['browser_viewport', '{"width":1280,"height":720}'],
      ['browser_observe', '{}'],
    ]) {
      const result = await session.execute(name, args, signal);
      assert.equal(result.code, 'cancelled');
      assert.equal(result.detail?.actionIssued, false);
    }
    assert.deepEqual(counts, { goto: 0, clicks: 0, fills: 0, reads: 0, evaluations: 0, screenshots: 0, viewportWrites: 0, reloads: 0 });
  } finally { await session.close(); }
});

test('cancelling an in-flight write never appends an observation or repeats the click', async () => {
  const { session, internal, element, counts } = fixture();
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const controller = new AbortController();
  element.click = () => { counts.clicks++; started.resolve(); return finished.promise; };
  try {
    const running = session.execute('browser_click', '{"id":"e0-0","observe":"read"}', controller.signal);
    await started.promise;
    controller.abort();
    const result = await running;
    assert.equal(result.code, 'cancelled');
    assert.equal(result.detail?.actionIssued, true);
    assert.equal(result.detail?.actionComplete, false);
    assert.equal(counts.clicks, 1);
    assert.equal(counts.reads, 0);
    assert.equal(counts.evaluations, 0);
    assert.equal(internal.suspendedActions.size, 1);
    assert.equal((await session.execute('browser_observe', '{}')).code, 'action-pending');
    assert.equal(counts.reads, 0);
  } finally {
    finished.resolve();
    await finished.promise;
    await session.close();
  }
});

test('completed click with failed observation reports completion without retry or sensitive exception', async () => {
  const { session, internal, counts } = fixture();
  internal.read = async () => { counts.reads++; throw new Error('private-token-never-log'); };
  try {
    const result = await session.execute('browser_click', '{"id":"e0-0","observe":"read"}');
    assert.equal(result.code, 'observation-failed');
    assert.equal(result.detail?.actionComplete, true);
    assert.equal(counts.clicks, 1);
    assert.equal(counts.reads, 1);
    assert.equal(counts.goto, 0);
    assert.equal(counts.reloads, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-token-never-log/);
  } finally { await session.close(); }
});

test('pending dialog returns control and state without evaluating or silently resolving it', async () => {
  const { session, page, counts } = fixture();
  let dismissed = 0;
  let accepted = 0;
  page.emit('dialog', {
    type: () => 'confirm', message: () => 'Untrusted instruction in dialog', defaultValue: () => '',
    dismiss: async () => { dismissed++; }, accept: async () => { accepted++; },
  });
  page.evaluate = async () => { throw new Error('must not evaluate under a modal dialog'); };
  try {
    const result = await session.execute('browser_observe', '{}');
    assert.equal(result.code, 'dialog-pending');
    assert.equal(JSON.parse(result.text).untrusted, true);
    assert.equal(stateOf(result).dialogs.length, 1);
    assert.equal(counts.reads, 0);
    assert.equal(counts.evaluations, 0);
    assert.equal(dismissed, 0);
    assert.equal(accepted, 0);
    assert.equal(counts.goto, 0);
  } finally { await session.close(); }
});

test('navigation with no response and no URL change reports diagnostics without a retry', async () => {
  const { session, page, counts } = fixture();
  page.goto = async () => { counts.goto++; return null; };
  try {
    const result = await session.execute('browser_open', '{"url":"https://fixture.example/start"}');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'navigation-unconfirmed');
    assert.deepEqual(result.detail?.navigation, { previous: 'https://fixture.example/start', current: 'https://fixture.example/start', noChange: true });
    assert.equal(stateOf(result).url, 'https://fixture.example/start');
    assert.equal(counts.goto, 1);
    assert.equal(counts.reloads, 0);
  } finally { await session.close(); }
});

test('failed navigation returns safe current state without retrying or leaking raw failure', async () => {
  const { session, page, counts } = fixture();
  page.goto = async () => { counts.goto++; throw new Error('private-network-error'); };
  try {
    const result = await session.execute('browser_open', '{"url":"https://fixture.example/next"}');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'action-unconfirmed');
    assert.equal(result.detail?.actionIssued, true);
    assert.equal(result.detail?.actionComplete, false);
    assert.equal(stateOf(result).url, 'https://fixture.example/start');
    assert.equal(counts.goto, 1);
    assert.equal(counts.reloads, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-network-error/);
  } finally { await session.close(); }
});

test('cancellation during metadata title fallback does not append another page evaluation', async () => {
  const { session, page, counts } = fixture();
  const started = Promise.withResolvers<void>();
  const title = Promise.withResolvers<string>();
  page.title = () => { started.resolve(); return title.promise; };
  const controller = new AbortController();
  try {
    const running = session.execute('browser_observe', '{}', controller.signal);
    await started.promise;
    const evaluationsBeforeCancel = counts.evaluations;
    assert.equal(evaluationsBeforeCancel, 1, 'combined metadata sampling precedes the legacy title fallback');
    controller.abort();
    const result = await running;
    assert.equal(result.code, 'cancelled');
    title.resolve('Late title');
    await title.promise;
    // Drain the already-issued metadata promise, without a clock wait.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(counts.evaluations, evaluationsBeforeCancel);
    assert.equal(counts.reads, 1);
    assert.equal(counts.goto, 0);
  } finally { title.resolve('Late title'); await session.close(); }
});

test('same-document hash navigation preserves known main-document HTTP status', async () => {
  const { session, page, response, counts, setUrl } = fixture();
  response.status = () => 502;
  try {
    await session.execute('browser_open', '{"url":"https://fixture.example/error"}');
    const frame = { url: () => 'https://fixture.example/error#section' };
    page.mainFrame = () => frame;
    setUrl(frame.url());
    page.emit('framenavigated', frame);
    const result = await session.execute('browser_observe', '{}');
    assert.equal(stateOf(result).httpStatus, 502);
    assert.equal(stateOf(result).url, frame.url());
    assert.equal(counts.goto, 1);
    assert.equal(counts.reloads, 0);
  } finally { await session.close(); }
});

test('unconfirmed click and fill failures never trigger a second write', async () => {
  for (const name of ['browser_click', 'browser_fill']) {
    const { session, element, counts } = fixture();
    element.click = async () => { counts.clicks++; throw new Error('private-click-failure'); };
    element.fill = async () => { counts.fills++; throw new Error('private-fill-failure'); };
    try {
      const args = name === 'browser_click' ? { id: 'e0-0', observe: 'read' } : { id: 'e0-0', text: 'fixture-value' };
      const result = await session.execute(name, JSON.stringify(args));
      assert.equal(result.code, 'action-unconfirmed');
      assert.equal(result.detail?.actionIssued, true);
      assert.equal(result.detail?.actionComplete, false);
      assert.equal(counts.clicks + counts.fills, 1);
      assert.equal(counts.reads, 0);
      assert.equal(counts.goto, 0);
      assert.equal(counts.reloads, 0);
      assert.doesNotMatch(JSON.stringify(result), /private-(click|fill)-failure/);
    } finally { await session.close(); }
  }
});

test('subresource failures do not replace the active main-document HTTP status', async () => {
  const { session, page, response } = fixture();
  try {
    await session.execute('browser_open', '{"url":"https://fixture.example/start"}');
    const frame = { url: () => 'https://fixture.example/start' };
    page.mainFrame = () => frame;
    page.emit('response', {
      request: () => ({ isNavigationRequest: () => false, frame: () => frame }),
      status: () => 502,
      url: () => 'https://fixture.example/script.js',
    });
    assert.equal(stateOf(await session.execute('browser_observe', '{}')).httpStatus, response.status());
    page.emit('response', {
      request: () => ({ isNavigationRequest: () => true, frame: () => ({}) }),
      status: () => 404,
      url: () => 'https://fixture.example/child-frame',
    });
    assert.equal(stateOf(await session.execute('browser_observe', '{}')).httpStatus, 200);
    page.emit('response', {
      request: () => ({ isNavigationRequest: () => true, frame: () => frame }),
      status: () => 502,
      url: () => frame.url(),
    });
    assert.equal(stateOf(await session.execute('browser_observe', '{}')).httpStatus, 502);
  } finally { await session.close(); }
});
