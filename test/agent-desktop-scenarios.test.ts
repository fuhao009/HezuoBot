import test from 'node:test';
import assert from 'node:assert/strict';
import { AxSession, axDefinitions } from '../src/agent-desktop.ts';

type Request = { name: string; arguments: Record<string, unknown> };
type ClientStub = {
  callTool(request: Request, ...rest: unknown[]): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};
type SessionState = {
  startup?: Promise<void>;
  start(): Promise<void>;
  client?: ClientStub;
};

function fixture(reply: (request: Request) => Record<string, unknown> = () => ({ structuredContent: { ok: true }, content: [] })) {
  const session = new AxSession({ binary: '/mock/agent-desktop' });
  const state = session as unknown as SessionState;
  const calls: Request[] = [];
  state.startup = Promise.resolve();
  state.client = {
    callTool: async request => {
      calls.push(request);
      return reply(request);
    },
    close: async () => {},
  };
  return { session, state, calls };
}

function successfulSnapshot(app: string, windowId: string, refId: string) {
  return {
    structuredContent: { ok: true, data: { app, window: { id: windowId }, tree: [{ ref_id: refId }] } },
    content: [],
  };
}

test('Agent Desktop tool definitions map current upstream argument names and parameter types', () => {
  const definitions = new Map(axDefinitions.map(definition => [definition.function.name, definition.function.parameters]));
  const expected: Record<string, Record<string, string>> = {
    desktop_list_apps: { app: 'string', timeout_ms: 'integer' },
    desktop_list_windows: { app: 'string', timeout_ms: 'integer' },
    desktop_launch: { app: 'string', activate: 'boolean', timeout: 'integer' },
    desktop_focus_window: { app: 'string', title: 'string', window_id: 'string' },
    desktop_wait: { app: 'string', window: 'string', window_id: 'string', event: 'string', timeout: 'integer' },
    desktop_snapshot: { app: 'string', window_id: 'string', surface: 'string', timeout_ms: 'integer' },
    desktop_click: { ref_id: 'string' },
    desktop_set_value: { ref_id: 'string', value: 'string' },
    desktop_type: { ref_id: 'string', text: 'string' },
    desktop_press: { app: 'string', window_id: 'string', combo: 'string' },
  };
  for (const [name, properties] of Object.entries(expected)) {
    const parameters = definitions.get(name);
    assert(parameters, `missing tool definition ${name}`);
    for (const [key, type] of Object.entries(properties)) {
      assert.equal(parameters.properties[key]?.type, type, `${name}.${key} must map to upstream ${type}`);
    }
    assert.equal(parameters.additionalProperties, false, `${name} must reject unmapped arguments`);
  }
  assert.deepEqual(definitions.get('desktop_launch')?.required, ['app']);
  assert.deepEqual(definitions.get('desktop_click')?.required, ['ref_id']);
  assert.deepEqual(definitions.get('desktop_set_value')?.required, ['ref_id', 'value']);
  assert.deepEqual(definitions.get('desktop_type')?.required, ['ref_id', 'text']);
  assert.deepEqual(definitions.get('desktop_press')?.required, ['combo']);
  assert.equal(definitions.get('desktop_snapshot')?.properties.surface?.enum instanceof Array, true);
});

test('preparation sequence forwards real schema arguments and observes after launch, focus and wait', async t => {
  const f = fixture();
  t.after(() => f.session.close());
  const steps: Request[] = [
    { name: 'desktop_list_apps', arguments: { app: 'Editor', timeout_ms: 2500 } },
    { name: 'desktop_list_windows', arguments: { app: 'Editor', timeout_ms: 2500 } },
    { name: 'desktop_launch', arguments: { app: 'Editor', activate: true, timeout: 4000 } },
    { name: 'desktop_focus_window', arguments: { app: 'Editor', title: 'Project', window_id: 'window-7' } },
    { name: 'desktop_wait', arguments: { app: 'Editor', window: 'Project', window_id: 'window-7', event: 'title-changed', timeout: 3000 } },
    { name: 'desktop_snapshot', arguments: { app: 'Editor', window_id: 'window-7', surface: 'window', timeout_ms: 5000 } },
  ];
  for (const step of steps) {
    const result = await f.session.execute(step.name, JSON.stringify(step.arguments));
    assert.equal(result.ok, true, `${step.name}: ${result.text}`);
  }
  assert.deepEqual(f.calls, steps);
  for (const [name, args] of [
    ['desktop_launch', { app: 'Editor', activate: 'yes' }],
    ['desktop_focus_window', { title: 'Project', unknown: 'ignored?' }],
    ['desktop_wait', { event: 'title-changed', timeout: 0 }],
    ['desktop_snapshot', { surface: 'not-a-real-surface' }],
    ['desktop_list_windows', { timeout_ms: 1.5 }],
  ] as const) {
    assert.equal((await f.session.execute(name, JSON.stringify(args))).ok, false, `${name} rejects invalid mapped args`);
  }
  assert.equal(f.calls.length, steps.length, 'invalid arguments never reach MCP');
});

test('fresh snapshots replace ref provenance; canceled input invalidates refs and is never replayed', async t => {
  const f = fixture(request => request.name === 'desktop_snapshot'
    ? successfulSnapshot('Editor', 'window-7', '@snapshot:old')
    : { structuredContent: { ok: true }, content: [] });
  t.after(() => f.session.close());
  assert.equal((await f.session.execute('desktop_snapshot', '{"app":"Editor","window_id":"window-7"}')).ok, true);
  f.calls.length = 0;
  assert.equal((await f.session.execute('desktop_click_and_snapshot', JSON.stringify({ ref_id: '@snapshot:old', app: 'Editor' }))).ok, true);
  assert.deepEqual(f.calls.map(call => call.name), ['desktop_click', 'desktop_snapshot']);

  // A later successful snapshot supersedes the previous ref set.
  f.calls.length = 0;
  const realCall = f.state.client!.callTool;
  f.state.client!.callTool = async request => {
    f.calls.push(request);
    return request.name === 'desktop_snapshot'
      ? successfulSnapshot('Editor', 'window-7', '@snapshot:new')
      : { structuredContent: { ok: true }, content: [] };
  };
  assert.equal((await f.session.execute('desktop_snapshot', '{"app":"Editor","window_id":"window-7"}')).ok, true);
  f.state.client!.callTool = realCall;
  f.calls.length = 0;
  assert.equal((await f.session.execute('desktop_click_and_snapshot', JSON.stringify({ ref_id: '@snapshot:old', app: 'Editor' }))).ok, false);
  assert.equal(f.calls.length, 0);

  const entered = Promise.withResolvers<void>();
  const abort = new AbortController();
  const { promise, reject } = Promise.withResolvers<Record<string, unknown>>();
  f.state.client!.callTool = async request => {
    f.calls.push(request);
    if (request.name === 'desktop_click') {
      entered.resolve();
      abort.signal.addEventListener('abort', () => reject(new Error('mock request stopped')), { once: true });
      return promise;
    }
    return successfulSnapshot('Editor', 'window-7', '@snapshot:new');
  };
  const pending = f.session.execute('desktop_click', '{"ref_id":"@snapshot:new"}', abort.signal);
  await entered.promise;
  abort.abort();
  assert.equal((await pending).code, 'CANCELLED');
  assert.deepEqual(f.calls.map(call => call.name), ['desktop_click'], 'canceled action is not retried and no snapshot is appended');
});
test('Stop reconnects on the next turn, but requires a fresh snapshot before further input', async t => {
  const f = fixture(request => request.name === 'desktop_snapshot'
    ? successfulSnapshot('Editor', 'window-7', '@snapshot:before-stop')
    : { structuredContent: { ok: true }, content: [] });
  t.after(() => f.session.close());
  assert.equal((await f.session.execute('desktop_snapshot', '{"app":"Editor","window_id":"window-7"}')).ok, true);
  const abort = new AbortController();
  const entered = Promise.withResolvers<void>();
  const { promise, reject } = Promise.withResolvers<Record<string, unknown>>();
  f.state.client!.callTool = async request => {
    if (request.name === 'desktop_type') {
      entered.resolve();
      abort.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      return promise;
    }
    return { structuredContent: { ok: true }, content: [] };
  };
  const pending = f.session.execute('desktop_type', '{"ref_id":"@snapshot:before-stop","text":"draft"}', abort.signal);
  await entered.promise;
  abort.abort();
  assert.equal((await pending).code, 'CANCELLED');

  const resumedCalls: Request[] = [];
  let starts = 0;
  f.state.start = async () => {
    starts++;
    f.state.client = {
      callTool: async request => {
        resumedCalls.push(request);
        return request.name === 'desktop_snapshot'
          ? successfulSnapshot('Editor', 'window-7', '@snapshot:after-stop')
          : { structuredContent: { ok: true }, content: [] };
      },
      close: async () => {},
    };
  };
  assert.equal((await f.session.execute('desktop_click', '{"ref_id":"@snapshot:before-stop"}')).ok, false);
  assert.equal(starts, 0, 'stale ref blocked before reconnect');
  assert.equal((await f.session.execute('desktop_snapshot', '{"app":"Editor","window_id":"window-7"}')).ok, true);
  assert.equal(starts, 1);
  assert.equal((await f.session.execute('desktop_click', '{"ref_id":"@snapshot:after-stop"}')).ok, true);
  assert.deepEqual(resumedCalls.map(call => call.name), ['desktop_snapshot', 'desktop_click']);
});
