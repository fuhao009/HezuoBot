import test from 'node:test';
import assert from 'node:assert/strict';
import { AxSession, axDefinitions, axToolNames } from '../src/agent-desktop.ts';
import { loadConfig, assertBackendPermissions } from '../src/config.ts';
import { Conversation } from '../src/core.ts';

type Stub = {
  startup?: Promise<void>;
  start(): Promise<void>;
  client?: { callTool(...args: unknown[]): Promise<Record<string, unknown>>; close(): Promise<void> };
  transport?: { close(): Promise<void> };
};
function fixture(reply: Record<string, unknown> = { structuredContent: { ok: true, data: {} }, content: [] }) {
  const session = new AxSession({ binary: '/mock/agent-desktop' });
  const state = session as unknown as Stub;
  const calls: unknown[][] = [];
  let closes = 0;
  state.startup = Promise.resolve();
  state.client = { callTool: async (...args) => { calls.push(args); return reply; }, close: async () => { closes++; } };
  state.transport = { close: async () => { closes++; } };
  return { session, state, calls, get closes() { return closes; } };
}

test('AX is lazy and exposes verified MCP application/window commands plus local combinations', async () => {
  const session = new AxSession();
  assert.match(session.status(), /not started/);
  assert.deepEqual(axToolNames, ['desktop_list_apps', 'desktop_list_windows', 'desktop_launch', 'desktop_focus_window', 'desktop_wait', 'desktop_snapshot', 'desktop_click', 'desktop_set_value', 'desktop_type', 'desktop_press', 'desktop_click_and_snapshot', 'desktop_set_value_and_snapshot']);
  for (const definition of axDefinitions) assert.equal(definition.function.parameters.additionalProperties, false);
  await session.close();
  await session.close();
  assert.match(session.status(), /closed/);
});

test('AX press forwards verified string fields and rejects unsafe or unknown fields locally', async () => {
  const f = fixture();
  const args = { app: 'Google Chrome', window_id: '42', combo: 'return' };
  assert.equal((await f.session.execute('desktop_press', JSON.stringify(args))).ok, true);
  assert.deepEqual(f.calls[0][0], { name: 'desktop_press', arguments: args });
  for (const invalid of [{}, { combo: 1 }, { combo: 'return', force: true }, { combo: 'return', url: 'https://www.tgb.cn/' }]) {
    assert.equal((await f.session.execute('desktop_press', JSON.stringify(invalid))).ok, false);
  }
  assert.equal(f.calls.length, 1);
  await f.session.close();
});

test('AX maps app/tree/reference/value calls without coordinate or CUA fallback', async () => {
  const f = fixture({ structuredContent: { ok: true, data: { tree: [{ ref: '@snapshot:e1', role: 'text' }] } }, content: [] });
  for (const [name, args] of [
    ['desktop_list_apps', {}], ['desktop_launch', { app: 'TextEdit' }],
    ['desktop_snapshot', { app: 'TextEdit' }], ['desktop_click', { ref_id: '@snapshot:e1' }],
    ['desktop_set_value', { ref_id: '@snapshot:e1', value: '' }],
    ['desktop_type', { ref_id: '@snapshot:e1', text: 'hello' }],
    ['desktop_snapshot', { app: 'TextEdit' }],
  ] as const) {
    const r = await f.session.execute(name, JSON.stringify(args));
    assert.equal(r.ok, true);
    assert.match(r.text, /@snapshot:e1/);
  }
  assert.equal(f.calls.length, 7);
  assert.deepEqual(f.calls[3][0], { name: 'desktop_click', arguments: { ref_id: '@snapshot:e1' } });
  for (const [name, raw] of [['computer_click', '{"x":1,"y":2}'], ['desktop_click', '{"ref":"bad"}'], ['desktop_type', '{"ref_id":"x","text":3}'], ['desktop_launch', '{"app":"x","shell":"bad"}'], ['desktop_snapshot', '[]']]) {
    assert.equal((await f.session.execute(name, raw)).ok, false);
  }
  assert.equal(f.calls.length, 7);
  await f.session.close();
});

test('AX reports upstream structured errors without retrying or changing provider', async () => {
  for (const isError of [true, false]) {
    const f = fixture({ isError, structuredContent: { ok: false, error: { code: 'STALE_REF', message: 'snapshot again' } }, content: [] });
    const result = await f.session.execute('desktop_click', '{"ref_id":"@old:e1"}');
    assert.equal(result.ok, false);
    assert.match(result.text, /STALE_REF/);
    assert.equal(f.calls.length, 1);
    await f.session.close();
  }
});

test('missing AX binary is actionable and never starts another backend', async () => {
  const session = new AxSession();
  const result = await session.execute('desktop_list_apps', '{}');
  assert.equal(result.ok, false);
  assert.match(result.text, /explicit absolute executable binary path/);
  assert.match(session.status(), /unavailable/);
  await session.close();
});

test('pre-cancellation and pause prohibit desktop calls; close is idempotent', async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  assert.equal((await f.session.execute('desktop_list_apps', '{}', abort.signal)).ok, false);
  assert.equal(f.calls.length, 0);
  f.session.pause();
  assert.equal((await f.session.execute('desktop_list_apps', '{}')).ok, false);
  await f.session.close();
  await f.session.close();
  assert.equal(f.closes, 2);
});

test('in-flight AX cancellation is forwarded to MCP and suppresses late success', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  f.state.client!.callTool = async (...args) => {
    const options = args[2] as { signal: AbortSignal };
    entered.resolve();
    const gate = Promise.withResolvers<void>();
    options.signal.addEventListener('abort', () => gate.resolve(), { once: true });
    await gate.promise;
    return { structuredContent: { ok: true, data: {} }, content: [] };
  };
  const abort = new AbortController();
  const pending = f.session.execute('desktop_list_apps', '{}', abort.signal);
  await entered.promise;
  abort.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANCELLED');
  await f.session.close();
});

test('AX preserves validated inline screenshots without starting a desktop', async () => {
  const image = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const f = fixture({ structuredContent: { ok: true, data: {} }, content: [{ type: 'image', mimeType: 'image/png', data: image }] });
  const result = await f.session.execute('desktop_snapshot', '{}');
  assert.equal(result.ok, true);
  assert.equal(result.image, image);
  assert.equal(result.mime, 'image/png');
  await f.session.close();
});

test('configuration explicitly selects AX or default CUA and rejects cross-provider permissions', () => {
  const base = { HEZUO_CORE_MODEL: 'mock', HEZUO_CORE_BROWSER_BACKEND: 'computer_use' };
  const cua = loadConfig(base);
  assert.equal(cua.desktopBackend, 'cua');
  assert(cua.tools.includes('computer_click'));
  const ax = loadConfig({ ...base, HEZUO_CORE_DESKTOP_BACKEND: 'ax', HEZUO_CORE_AX_BINARY: '/mock/agent-desktop' });
  assert.equal(ax.desktopBackend, 'ax');
  assert(ax.tools.includes('desktop_snapshot'));
  assert(!ax.tools.includes('computer_click'));
  assert.throws(() => assertBackendPermissions({ ...ax, tools: ['computer_click'] }));
  assert.throws(() => assertBackendPermissions({ ...cua, tools: ['desktop_click'] }));
  assert.throws(() => loadConfig({ ...base, HEZUO_CORE_DESKTOP_BACKEND: 'auto' }));
  assert.throws(() => loadConfig({ ...base, HEZUO_CORE_DESKTOP_BACKEND: 'ax', HEZUO_CORE_AX_BINARY: 'relative/path' }));
});

test('conversation snapshots desktop selection even if caller configuration changes', async () => {
  const config = loadConfig({ HEZUO_CORE_MODEL: 'mock', HEZUO_CORE_BROWSER_BACKEND: 'computer_use', HEZUO_CORE_DESKTOP_BACKEND: 'ax' });
  const conversation = new Conversation(config);
  config.desktopBackend = 'cua';
  config.tools.splice(0, config.tools.length, 'computer_click');
  assert.match(conversation.browserStatus(), /Desktop backend: ax/);
  assert.match(conversation.browserStatus(), /not started/);
  await conversation.close();
});

test('AX startup/version/schema failure closes its resources and is not retried', async () => {
  const f = fixture();
  f.state.startup = undefined;
  let starts = 0;
  f.state.start = async () => { starts++; throw new Error('Agent Desktop 1.3.1 tool catalog incompatible: desktop_click'); };
  for (let i = 0; i < 2; i++) {
    const result = await f.session.execute('desktop_list_apps', '{}');
    assert.equal(result.ok, false);
    assert.match(result.text, /catalog incompatible/);
  }
  assert.equal(starts, 1);
  assert.equal(f.calls.length, 0);
  assert(f.closes >= 2);
  await f.session.close();
});

test('cancelling AX while startup is pending releases the owned transport', async () => {
  const f = fixture();
  f.state.startup = undefined;
  const entered = Promise.withResolvers<void>();
  f.state.start = async () => {
    entered.resolve();
    const gate = Promise.withResolvers<void>();
    const sessionState = f.session as unknown as { abort: AbortController };
    sessionState.abort.signal.addEventListener('abort', () => gate.resolve(), { once: true });
    await gate.promise;
    sessionState.abort.signal.throwIfAborted();
  };
  const abort = new AbortController();
  const pending = f.session.execute('desktop_list_apps', '{}', abort.signal);
  await entered.promise;
  abort.abort();
  assert.equal((await pending).code, 'CANCELLED');
  assert.equal(f.calls.length, 0);
  assert.equal(f.closes, 2);
  await f.session.close();
});

test('Stop allows next-turn AX reconnect but requires fresh observation before writes', async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  assert.equal((await f.session.execute('desktop_list_apps', '{}', abort.signal)).code, 'CANCELLED');
  assert.match(f.session.status(), /next turn must observe/);
  let starts = 0;
  const calls: string[] = [];
  f.state.start = async () => {
    starts++;
    f.state.client = {
      callTool: async (...args) => {
        const request = args[0];
        assert(request && typeof request === 'object' && 'name' in request && typeof request.name === 'string');
        calls.push(request.name);
        return { structuredContent: { ok: true, data: { tree: [] } }, content: [] };
      },
      close: async () => {},
    };
  };
  assert.equal((await f.session.execute('desktop_click', '{"ref_id":"@old:e1"}')).ok, false);
  assert.equal(starts, 0);
  assert.equal((await f.session.execute('desktop_snapshot', '{}')).ok, true);
  assert.equal(starts, 1);
  assert.equal((await f.session.execute('desktop_click', '{"ref_id":"@fresh:e1"}')).ok, true);
  assert.deepEqual(calls, ['desktop_snapshot', 'desktop_click']);
  await f.session.close();
  assert.equal((await f.session.execute('desktop_snapshot', '{}')).ok, false);
});

async function observeCombinationRef(f: { session: AxSession; state: Stub; calls: unknown[][] }) {
  const dispatch = f.state.client!.callTool;
  f.state.client!.callTool = async () => ({ structuredContent: { ok: true, data: { app: 'Editor', window: { id: '42' }, tree: [{ ref_id: '@snapshot:e1' }] } }, content: [] });
  assert.equal((await f.session.execute('desktop_snapshot', '{"app":"Editor","window_id":"42"}')).ok, true);
  f.state.client!.callTool = dispatch;
  f.calls.length = 0;
  f.session.audit.length = 0;
}

test('AX combinations reuse the client and snapshot the explicitly scoped application', async () => {
  for (const name of ['desktop_click_and_snapshot', 'desktop_set_value_and_snapshot']) {
    const f = fixture();
    await observeCombinationRef(f);
    const result = await f.session.execute(name, JSON.stringify({ app: 'Editor', window_id: '42', ref_id: '@snapshot:e1', ...(name.includes('set_value') ? { value: '' } : {}) }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.detail, { actionOk: true, observationAttempted: true, observationOk: true });
    assert.deepEqual(f.calls.map(call => call[0]), [
      { name: name.includes('set_value') ? 'desktop_set_value' : 'desktop_click', arguments: { ref_id: '@snapshot:e1', ...(name.includes('set_value') ? { value: '' } : {}) } },
      { name: 'desktop_snapshot', arguments: { app: 'Editor', window_id: '42' } },
    ]);
    assert.equal(f.closes, 0);
    await f.session.close();
  }
});

test('AX combination skips observation when disabled, failed or cancelled and never replays', async () => {
  for (const mode of ['disabled', 'failed', 'cancelled', 'paused', 'observation-error']) {
    const f = fixture();
    await observeCombinationRef(f);
    const controller = new AbortController();
    const dispatch = f.state.client!.callTool;
    f.state.client!.callTool = async (...args) => {
      const reply = await dispatch(...args);
      if (mode === 'cancelled') controller.abort();
      if (mode === 'paused') f.session.pause();
      if (mode === 'failed' || mode === 'observation-error' && f.calls.length === 2) return { isError: true, content: [] };
      return reply;
    };
    const result = await f.session.execute('desktop_click_and_snapshot', JSON.stringify({ ref_id: '@snapshot:e1', app: 'Editor', ...(mode === 'disabled' ? { observe: false } : {}) }), controller.signal);
    assert.equal(f.calls.length, mode === 'observation-error' ? 2 : 1);
    assert.equal(result.ok, mode === 'disabled');
    if (mode === 'observation-error') {
      assert.equal(result.detail?.actionOk, true);
      assert.equal(result.detail?.observationOk, false);
      assert.match(result.text, /Do not replay/);
    }
    await f.session.close();
  }
});

test('AX invalid combination and pre-cancelled invocation send no MCP requests', async () => {
  for (const raw of ['{}', '{"ref_id":"x","app":"Editor","observe":"yes"}', '{"ref_id":"x","app":"Editor","extra":1}']) {
    const f = fixture();
    assert.equal((await f.session.execute('desktop_click_and_snapshot', raw)).ok, false);
    assert.equal(f.calls.length, 0);
    await f.session.close();
  }
  const f = fixture();
  assert.equal((await f.session.execute('desktop_click_and_snapshot', '{"ref_id":"x","app":"Editor"}', AbortSignal.abort())).ok, false);
  assert.equal(f.calls.length, 0);
  await f.session.close();
});

test('AX combination observation preserves image/mime without base64 text or audit duplication', async () => {
  const f = fixture();
  await observeCombinationRef(f);
  const image = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const dispatch = f.state.client!.callTool;
  f.state.client!.callTool = async (...args) => {
    await dispatch(...args);
    return f.calls.length === 2
      ? { structuredContent: { ok: true, data: { tree: [] } }, content: [{ type: 'image', mimeType: 'image/png', data: image }] }
      : { structuredContent: { ok: true }, content: [] };
  };
  const result = await f.session.execute('desktop_click_and_snapshot', '{"app":"Editor","ref_id":"@snapshot:e1"}');
  assert.equal(result.ok, true);
  assert.equal(result.image, image);
  assert.equal(result.mime, 'image/png');
  assert(!result.text.includes(image));
  assert(!JSON.stringify(f.session.audit).includes(image));
  assert.equal(f.session.audit.length, 2);
  await f.session.close();
});

test('AX combinations reject unknown refs and mismatched source app/window without input', async () => {
  const f = fixture();
  await observeCombinationRef(f);
  for (const args of [
    { ref_id: '@snapshot:e1', app: 'Other' },
    { ref_id: '@snapshot:e1', app: 'Editor', window_id: 'other-window' },
    { ref_id: '@unknown:e1', app: 'Editor' },
  ]) assert.equal((await f.session.execute('desktop_click_and_snapshot', JSON.stringify(args))).ok, false);
  assert.equal(f.calls.length, 0);
  await f.session.close();
});
