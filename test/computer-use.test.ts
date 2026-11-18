import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputerSession, computerDefinitions } from '../src/computer-use.ts';

type Reply = { data: Record<string, unknown>; content?: Array<{ type: string; mimeType?: string; data?: string }> };
type StubState = {
  startup: Promise<void>;
  timedCall(name: string, args: Record<string, unknown>): Promise<Reply>;
};
// Transport-only fixture: no browser, daemon, model or service is started.
function fixture() {
  const session = new ComputerSession();
  const state = session as unknown as StubState;
  const calls: Array<[string, Record<string, unknown>]> = [];
  state.startup = Promise.resolve();
  state.timedCall = async (name, args) => { calls.push([name, args]); return { data: { effect: 'dispatched' } }; };
  return { session, state, calls };
}

// Minimal bytes for the retained PNG signature/dimension checks, not a PNG decoder test.
function screenshot(width = 2000, height = 1600, bytes = 24): Reply {
  const png = Buffer.alloc(bytes);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return { data: {}, content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] };
}

test('schema removes text caps and key allowlists while preserving argument shapes and explicit pause', () => {
  const tools = Object.fromEntries(computerDefinitions.map(d => [d.function.name, d.function]));
  const text = tools.computer_type.parameters.properties;
  assert('text' in text);
  assert.equal('maxLength' in text.text, false);
  assert.equal('enum' in text.text, false);
  const hotkey = tools.computer_hotkey.parameters.properties;
  const key = tools.computer_press_key.parameters.properties;
  assert('keys' in hotkey && !('enum' in hotkey.keys));
  assert('key' in key && !('enum' in key.key));
  assert(tools.computer_pause);
  for (const tool of Object.values(tools)) assert.equal(tool.parameters.additionalProperties, false);
});

test('desktop input has no screenshot prerequisite, window binding, text policy or key allowlist', async () => {
  const { session, calls } = fixture();
  const longText = '长文本'.repeat(8000);
  for (const [name, args] of [
    ['computer_type', { text: '普通注册显示名 Alice' }],
    ['computer_type', { text: longText }],
    ['computer_type', { text: 'text\ncommand\tvalue\u0000' }],
    ['computer_type', { text: 'javascript:alert(1)' }],
    ['computer_type', { text: 'file:///tmp/test' }],
    ['computer_type', { text: 'http://127.0.0.1/' }],
    ['computer_type', { text: 'https://example.com/?token=secret' }],
    ['computer_hotkey', { keys: 'cmd+v' }],
    ['computer_hotkey', { keys: 'cmd+space' }],
    ['computer_hotkey', { keys: 'cmd+o' }],
    ['computer_hotkey', { keys: 'cmd + shift + l' }],
    ['computer_press_key', { key: 'f12' }],
    ['computer_press_key', { key: 'enter' }],
    ['computer_click', { x: 0, y: 0 }],
    ['computer_click', { x: 4000, y: 3000 }],
    ['computer_scroll', { x: 2, y: 20, direction: 'down' }],
  ] as const) assert.equal((await session.execute(name, JSON.stringify(args))).ok, true, name);
  for (const [, args] of calls) {
    assert.deepEqual(args.target, { kind: 'desktop', display_id: 'primary' });
    assert.equal(args.delivery_mode, 'foreground');
    assert.equal('capture_id' in args, false);
  }
  assert.equal(calls[1][1].text, longText);
  assert.deepEqual(calls[10][1].keys, ['cmd', 'shift', 'l']);
  assert.equal(calls[12][1].key, 'return');
});

test('invalid JSON, argument shapes, values and coordinates never reach transport', async () => {
  for (const [name, raw] of [
    ['shell', '{}'], ['computer_type', '{'], ['computer_type', 'null'],
    ['computer_type', '[]'], ['computer_type', '"text"'],
    ['computer_type', '{}'], ['computer_type', '{"text":"ok","extra":true}'],
    ['computer_type', '{"text":12}'], ['computer_type', '{"text":""}'],
    ['computer_hotkey', '{"keys":""}'], ['computer_hotkey', '{"keys":"cmd++v"}'],
    ['computer_hotkey', '{"keys":"cmd+ "}'], ['computer_hotkey', '{"keys":[]}'],
    ['computer_press_key', '{"key":" "}'], ['computer_press_key', '{"key":false}'],
    ['computer_click', '{"x":-1,"y":0}'], ['computer_click', '{"x":0.5,"y":0}'],
    ['computer_click', '{"x":"2","y":0}'], ['computer_click', '{"x":1e309,"y":0}'],
    ['computer_click', '{"x":9007199254740992,"y":0}'],
    ['computer_scroll', '{"x":0,"y":0,"direction":"left"}'],
    ['computer_pause', '{"extra":true}'], ['computer_window', '{"extra":true}'],
  ]) {
    const { session, calls } = fixture();
    assert.equal((await session.execute(name, raw)).ok, false, `${name} ${raw}`);
    assert.equal(calls.length, 0);
  }
});

test('large desktop captures have no application size caps or window ownership fields', async () => {
  const { session, state } = fixture();
  const reply = screenshot(2000, 1600, 700_000);
  state.timedCall = async (name, args) => {
    assert.equal(name, 'get_desktop_state');
    assert.deepEqual(args, {});
    return reply;
  };
  const result = await session.execute('computer_window', '{}');
  assert.equal(result.ok, true);
  assert(result.image!.length > 900_000);
  assert.match(result.text, /2000x1600/);
});

test('malformed screenshot transport payloads remain rejected', async () => {
  const mutations: Array<(reply: Reply) => void> = [
    reply => { reply.content = []; },
    reply => { reply.content!.push(reply.content![0]); },
    reply => { reply.content![0].mimeType = 'image/jpeg'; },
    reply => { reply.content![0].data = 'not base64!'; },
    reply => { reply.content![0].data = Buffer.alloc(24).toString('base64'); },
    reply => { reply.content![0].data = 'AA=='; },
    reply => { reply.content![0].data = screenshot(0).content![0].data; },
    reply => { reply.content![0].data = screenshot(2000, 0).content![0].data; },
  ];
  for (const mutate of mutations) {
    const { session, state } = fixture();
    const reply = screenshot();
    mutate(reply);
    state.timedCall = async () => reply;
    assert.equal((await session.execute('computer_window', '{}')).ok, false);
  }
});

test('explicit pause and close stop later screenshots and inputs', async () => {
  for (const stop of ['pause', 'close']) {
    const { session, calls } = fixture();
    if (stop === 'pause') assert.equal((await session.execute('computer_pause', '{ }')).ok, true);
    else await session.close();
    assert.equal((await session.execute('computer_window', '{}')).ok, false);
    assert.equal((await session.execute('computer_type', '{"text":"hello"}')).ok, false);
    assert.equal(calls.length, 0);
  }
  const { session, state } = fixture();
  state.timedCall = async () => { session.pause(); return screenshot(); };
  const result = await session.execute('computer_window', '{}');
  assert.equal(result.ok, false);
  assert.equal(result.image, undefined);
});

test('100 consecutive inputs need no intervening captures or action budget', async () => {
  const { session, calls } = fixture();
  for (let i = 0; i < 100; i++) assert.equal((await session.execute('computer_press_key', '{"key":"tab"}')).ok, true);
  assert.equal(calls.length, 100);
  assert.match(session.status(), /100 cumulative tool attempts/);
  assert.doesNotMatch(session.status(), /\/15|exhaust|budget/i);
});

test('repeated refused or failed inputs cannot lock out later valid instructions', async () => {
  for (const failure of ['refused', 'failed', 'throw']) {
    const { session, state, calls } = fixture();
    const dispatch = state.timedCall;
    state.timedCall = async () => {
      if (failure === 'throw') throw new Error('mock transport error');
      return { data: { effect: failure } };
    };
    for (let i = 0; i < 20; i++) assert.equal((await session.execute('computer_press_key', '{"key":"tab"}')).ok, false);
    state.timedCall = dispatch;
    assert.equal((await session.execute('computer_press_key', '{"key":"tab"}')).ok, true);
    assert.equal(calls.length, 1);
    assert.match(session.status(), /21 cumulative tool attempts; 20 cumulative input failures/);
  }
});

test('MCP calls retain cancellation without an application-specified deadline', async () => {
  const session = new ComputerSession();
  let options: { signal?: AbortSignal; timeout?: number } | undefined;
  let closes = 0;
  const state = session as unknown as {
    client: { callTool(request: unknown, schema: unknown, opts: typeof options): Promise<unknown>; close(): Promise<void> };
    call(name: string, args: Record<string, unknown>): Promise<unknown>;
  };
  state.client = {
    callTool: async (_request, _schema, opts) => { options = opts; return { content: [], structuredContent: {} }; },
    close: async () => { closes++; },
  };
  await state.call('list_windows', { pid: 123 });
  assert(options?.signal instanceof AbortSignal);
  assert.equal(Object.hasOwn(options!, 'timeout'), false);
  await session.close();
  assert.equal(closes, 1);
  await session.close();
  assert.equal(closes, 1);
  assert.equal(options!.signal!.aborted, true);
  await assert.rejects(state.call('list_windows', { pid: 123 }));
});

test('single-action combination uses existing input mappings and returns screenshot only as image/mime', async () => {
  for (const [name, args, upstream] of [
    ['computer_click', { x: 10, y: 20 }, 'click'],
    ['computer_scroll', { x: 10, y: 20, direction: 'down' }, 'scroll'],
    ['computer_hotkey', { keys: 'cmd+a' }, 'hotkey'],
    ['computer_type', { text: 'hello' }, 'type_text'],
    ['computer_press_key', { key: 'enter' }, 'press_key'],
  ] as const) {
    const { session, state, calls } = fixture();
    state.timedCall = async (tool, values) => { calls.push([tool, values]); return tool === 'get_desktop_state' ? screenshot() : { data: { effect: 'dispatched' } }; };
    const result = await session.execute('computer_action_and_screenshot', JSON.stringify({ action: { name, arguments: args } }));
    assert.equal(result.ok, true);
    assert.equal(result.image, screenshot().content![0].data);
    assert.equal(result.mime, 'image/png');
    assert(!result.text.includes(result.image!));
    assert.deepEqual(result.detail, { actionOk: true, observationAttempted: true, observationOk: true });
    assert.deepEqual(calls.map(call => call[0]), [upstream, 'get_desktop_state']);
    assert.deepEqual(calls[0][1].target, { kind: 'desktop', display_id: 'primary' });
    assert.equal(calls[0][1].delivery_mode, 'foreground');
  }
});

test('combination reports observation failure without losing successful action or replaying', async () => {
  for (const mode of ['malformed', 'throw', 'refused', 'failed', 'disabled']) {
    const { session, state, calls } = fixture();
    state.timedCall = async (name, args) => {
      calls.push([name, args]);
      if (name === 'get_desktop_state') {
        if (mode === 'throw') throw new Error('capture failed');
        return { data: {}, content: [] };
      }
      return { data: { effect: ['refused', 'failed'].includes(mode) ? mode : 'dispatched' } };
    };
    const result = await session.execute('computer_action_and_screenshot', JSON.stringify({ action: { name: 'computer_click', arguments: { x: 1, y: 2 } }, ...(mode === 'disabled' ? { observe: false } : {}) }));
    assert.equal(result.ok, mode === 'disabled');
    assert.equal(calls.length, ['malformed', 'throw'].includes(mode) ? 2 : 1);
    if (['malformed', 'throw'].includes(mode)) {
      assert.deepEqual(result.detail, { actionOk: true, observationAttempted: true, observationOk: false });
      assert.match(result.text, /Do not replay/);
    }
    assert.equal(result.image, undefined);
  }
});

test('CUA cancellation before input, during input or during capture appends nothing and discards late images', async () => {
  for (const stage of ['before', 'input', 'capture']) {
    const { session, state, calls } = fixture();
    const controller = new AbortController();
    if (stage === 'before') controller.abort();
    state.timedCall = async (name, args) => {
      calls.push([name, args]);
      if (stage === 'input' || name === 'get_desktop_state') controller.abort();
      return name === 'get_desktop_state' ? screenshot() : { data: { effect: 'dispatched' } };
    };
    const result = await session.execute('computer_action_and_screenshot', '{"action":{"name":"computer_press_key","arguments":{"key":"tab"}}}', controller.signal);
    assert.equal(result.ok, false);
    assert.equal(result.image, undefined);
    assert.equal(calls.length, stage === 'before' ? 0 : stage === 'input' ? 1 : 2);
    // A stopped request does not close the session. Reinstall the transport-only
    // fixture after its owned connection cleanup instead of touching a real daemon.
    state.startup = Promise.resolve();
    state.timedCall = async (name, args) => { calls.push([name, args]); return screenshot(); };
    assert.equal((await session.execute('computer_window', '{}')).ok, true);
    await session.close();
  }
});

test('CUA rejects batches, unsupported actions and malformed combination arguments before dispatch', async () => {
  for (const values of [{}, { action: [] }, { action: { name: 'computer_window', arguments: {} } }, { action: { name: 'computer_click', arguments: { x: -1, y: 2 } } }, { action: { name: 'computer_type', arguments: { text: 'x' }, extra: true } }, { action: { name: 'computer_press_key', arguments: { key: 'tab' } }, observe: 'yes' }]) {
    const { session, calls } = fixture();
    assert.equal((await session.execute('computer_action_and_screenshot', JSON.stringify(values))).ok, false);
    assert.equal(calls.length, 0);
  }
});

test('CUA combination real audit wrapper records metadata only, never screenshot bytes', async () => {
  const session = new ComputerSession();
  const state = session as unknown as { startup: Promise<void>; client: { callTool(request: { name: string }): Promise<unknown>; close(): Promise<void> } };
  state.startup = Promise.resolve();
  state.client = {
    callTool: async request => request.name === 'get_desktop_state' ? { structuredContent: {}, content: screenshot().content } : { structuredContent: { effect: 'dispatched' }, content: [] },
    close: async () => {},
  };
  const result = await session.execute('computer_action_and_screenshot', '{"action":{"name":"computer_press_key","arguments":{"key":"tab"}}}');
  assert.equal(result.ok, true);
  assert.equal(session.audit.length, 2);
  assert.deepEqual(session.audit.map(entry => entry.tool), ['press_key', 'get_desktop_state']);
  assert(!JSON.stringify(session.audit).includes(result.image!));
  assert(!result.text.includes(result.image!));
  await session.close();
});
