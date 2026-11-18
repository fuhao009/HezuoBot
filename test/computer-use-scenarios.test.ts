import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputerSession, computerDefinitions, computerToolNames } from '../src/computer-use.ts';

type Reply = { data: Record<string, unknown>; content?: Array<{ type: string; mimeType?: string; data?: string; text?: string }> };
type MockSession = {
  start(): Promise<void>;
  startup?: Promise<void>;
  client?: { callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>; close(): Promise<void> };
};

// Replace the startup boundary before any execute call. Never load a native driver,
// inspect sockets, launch stdio or contact a real desktop, even on macOS.
function fixture(reply: (name: string, args: Record<string, unknown>) => Reply | Promise<Reply> = () => ({ data: { effect: 'dispatched' } })) {
  const session = new ComputerSession();
  const state = session as unknown as MockSession;
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let starts = 0;
  const client: NonNullable<MockSession['client']> = {
    callTool: async request => {
      calls.push(request);
      const result = await reply(request.name, request.arguments);
      return { structuredContent: result.data, content: result.content ?? [] };
    },
    close: async () => {},
  };
  state.client = client;
  state.start = async () => { starts++; state.client = client; };
  return { session, state, calls, starts: () => starts };
}

function capture(width = 2880, height = 1800): Reply {
  // Header fixture for the existing PNG validation boundary, not an encoder/decoder test.
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return { data: {}, content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] };
}
const combination = (name = 'computer_click', args: Record<string, unknown> = { x: 100, y: 200 }, observe?: boolean) => JSON.stringify({ action: { name, arguments: args }, ...(observe === undefined ? {} : { observe }) });
function textContext(text: string) {
  return JSON.parse(text.split('\nComputer context: ')[1]);
}

test('construction and repeated read-only status remain lazy, including after pause/close', async () => {
  const { session, calls, starts } = fixture();
  assert.equal(starts(), 0);
  assert(computerToolNames.includes('computer_status'));
  assert(computerDefinitions.some(d => d.function.name === 'computer_status'));
  for (let i = 0; i < 2; i++) {
    const result = await session.execute('computer_status', '{}');
    assert.equal(result.ok, true);
    assert.equal(result.context?.driver.connection, 'not_started');
    assert.equal(result.context?.driver.catalogValidated, false);
    assert.deepEqual(result.context?.driver.capabilities, []);
    assert.equal(result.context?.permissions, 'unknown');
    assert.equal(result.context?.focus, 'unknown');
    assert.equal(result.context?.lastCapture, 'never');
    assert.equal(result.context?.lastScreenshot, null);
    assert.deepEqual(textContext(result.text).context, result.context);
    assert.equal(result.image, undefined);
  }
  await session.execute('computer_pause', '{}');
  assert.equal((await session.execute('computer_status', '{}')).context?.lifecycle, 'paused');
  await session.close();
  const closed = await session.execute('computer_status', '{}');
  assert.equal(closed.context?.lifecycle, 'closed');
  assert.equal(closed.context?.driver.connection, 'closed');
  assert.equal(starts(), 0);
  assert.deepEqual(calls, []);
});

test('PNG geometry and primary screenshot coordinate context reach both result and existing text consumers', async () => {
  const reply = capture();
  // Unrecognized driver fields/log text must not become fabricated scale/focus facts.
  reply.data = { width: 1440, height: 900, scale: 2, foreground_app: 'Guessed app' };
  reply.content!.unshift({ type: 'text', text: 'log: scale=3 foreground=Other' });
  const { session, calls } = fixture(() => reply);
  const result = await session.execute('computer_window', '{}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.screenshot?.physicalPixels, { width: 2880, height: 1800, source: 'png' });
  assert.deepEqual(result.screenshot?.coordinates, { unit: 'screenshot_pixel', origin: 'top-left', xDirection: 'right', yDirection: 'down' });
  assert.equal(result.screenshot?.target.display_id, 'primary');
  assert.equal(result.screenshot?.target.resolvedDisplayId, null);
  assert.equal(result.screenshot?.scaleFactor, null);
  assert.equal(result.screenshot?.foregroundApp, null);
  assert.equal(result.screenshot?.dimensionsChanged, false);
  assert.equal(result.screenshot?.relocationRequired, false);
  assert.equal(result.screenshot?.sequence, 1);
  assert(Number.isFinite(Date.parse(result.screenshot!.capturedAt)));
  assert.equal(result.mime, 'image/png');
  assert.equal(result.image, reply.content![1].data);
  assert(!result.text.includes(result.image!));
  assert(!result.text.includes('Guessed app'));
  assert(!result.text.includes('log:'));
  assert.deepEqual(textContext(result.text).screenshot, result.screenshot);
  assert.deepEqual(calls, [{ name: 'get_desktop_state', arguments: {} }]);
  const status = await session.execute('computer_status', '{}');
  assert.equal(status.context?.lastCapture, 'succeeded');
  assert.deepEqual(status.context?.lastScreenshot, result.screenshot);
  // A mocked startup is not evidence that the actual catalog was validated.
  assert.equal(status.context?.driver.catalogValidated, false);
  result.screenshot!.physicalPixels.width = 1;
  status.context!.lastScreenshot!.physicalPixels.width = 2;
  assert.equal((await session.execute('computer_status', '{}')).context?.lastScreenshot?.physicalPixels.width, 2880);
});

test('action plus resized observation marks relocation without scaling/replaying input or adding a gate', async () => {
  let screenshots = 0;
  const { session, calls } = fixture(name => name === 'get_desktop_state' ? capture(++screenshots === 1 ? 2880 : 1920, screenshots === 1 ? 1800 : 1080) : { data: { effect: 'dispatched' } });
  await session.execute('computer_window', '{}');
  const result = await session.execute('computer_action_and_screenshot', combination());
  assert.equal(result.ok, true);
  assert.equal(result.action?.dispatch, 'dispatched');
  assert.equal(result.action?.businessSuccess, 'unverified');
  assert.equal(result.observation?.status, 'succeeded');
  assert.equal(result.observation?.businessSuccess, 'unverified');
  assert.equal(result.screenshot?.dimensionsChanged, true);
  assert.equal(result.screenshot?.relocationRequired, true);
  assert.deepEqual(result.screenshot?.previousPhysicalPixels, { width: 2880, height: 1800 });
  assert.equal(result.screenshot?.sequence, 2);
  assert.match(result.text, /Re-locate/);
  assert.match(result.text, /do not reuse old coordinates/);
  assert.deepEqual(calls.map(c => c.name), ['get_desktop_state', 'click', 'get_desktop_state']);
  assert.deepEqual(calls[1].arguments, { target: { kind: 'desktop', display_id: 'primary' }, delivery_mode: 'foreground', x: 100, y: 200, button: 'left' });
  // Advice is not a hard prerequisite; no auto-focus or coordinate transformation.
  assert.equal((await session.execute('computer_click', '{"x":100,"y":200}')).ok, true);
  const next = await session.execute('computer_window', '{}');
  assert.equal(next.screenshot?.dimensionsChanged, false);
  assert.equal(next.screenshot?.relocationRequired, false);
  assert.match(next.text, /do not prove unchanged content or focus/);
});

test('Backspace stays on single-key API and Meta+l is one hotkey call without focus automation', async () => {
  const { session, calls } = fixture();
  assert.equal((await session.execute('computer_press_key', '{"key":"Backspace"}')).ok, true);
  assert.equal((await session.execute('computer_hotkey', '{"keys":"Meta+l"}')).ok, true);
  assert.equal((await session.execute('computer_type', '{"text":"https://example.com"}')).ok, true);
  assert.deepEqual(calls.map(c => c.name), ['press_key', 'hotkey', 'type_text']);
  assert.equal(calls[0].arguments.key, 'Backspace');
  assert.deepEqual(calls[1].arguments.keys, ['Meta', 'l']);
  const descriptions = Object.fromEntries(computerDefinitions.map(d => [d.function.name, d.function.description]));
  assert.match(descriptions.computer_hotkey, /Backspace.*computer_press_key/);
  assert.match(descriptions.computer_press_key, /Meta\+l/);
  assert.match(descriptions.computer_click, /resized preview/);
});

for (const effect of ['dispatched', 'confirmed', 'unverifiable', undefined] as const) {
  test(`dispatch evidence is separate from ok and business outcome: ${effect ?? 'only ok'}`, async () => {
    const { session, calls } = fixture(name => name === 'get_desktop_state' ? capture() : { data: { ok: true, ...(effect ? { effect } : {}) } });
    const result = await session.execute('computer_action_and_screenshot', combination());
    assert.equal(result.ok, true);
    assert.equal(result.action?.dispatch, effect === 'dispatched' || effect === 'confirmed' ? 'dispatched' : 'unknown');
    assert.equal(result.action?.driverEffect, effect);
    assert.equal(result.action?.businessSuccess, 'unverified');
    assert.equal(result.observation?.status, 'succeeded');
    assert.equal(result.observation?.businessSuccess, 'unverified');
    assert.deepEqual(result.detail, { actionOk: true, observationAttempted: true, observationOk: true });
    assert.deepEqual(textContext(result.text).action, result.action);
    assert.deepEqual(calls.map(c => c.name), ['click', 'get_desktop_state']);
  });
}

for (const mode of ['refused', 'failed', 'ok-false', 'throw', 'mcp-error', 'cancel'] as const) {
  test(`action failure/cancellation does not append a screenshot: ${mode}`, async () => {
    const controller = new AbortController();
    const { session, state, calls } = fixture(() => {
      if (mode === 'throw') throw new Error('mock transport failure');
      if (mode === 'cancel') controller.abort();
      return { data: mode === 'ok-false' ? { ok: false } : { effect: mode === 'cancel' ? 'dispatched' : mode } };
    });
    if (mode === 'mcp-error') state.client!.callTool = async request => {
      calls.push(request);
      return { isError: true, content: [{ type: 'text', text: 'mock failure' }] };
    };
    const result = await session.execute('computer_action_and_screenshot', combination(), controller.signal);
    assert.equal(result.ok, false);
    assert.equal(result.action?.dispatch, mode === 'refused' ? 'not_dispatched' : 'unknown');
    assert.equal(result.action?.businessSuccess, 'unverified');
    assert.equal(result.observation?.attempted, false);
    assert.equal(result.image, undefined);
    assert.deepEqual(calls.map(c => c.name), ['click']);
    assert.match(result.text, /[Dd]o not replay/);
    if (mode === 'cancel') assert.equal(result.code, 'CANCELLED');
  });
}

test('observe=false preserves dispatch metadata and does not capture', async () => {
  const { session, calls } = fixture();
  const result = await session.execute('computer_action_and_screenshot', combination('computer_type', { text: 'hello' }, false));
  assert.equal(result.ok, true);
  assert.equal(result.action?.dispatch, 'dispatched');
  assert.equal(result.observation?.status, 'skipped');
  assert.equal(result.observation?.attempted, false);
  assert.equal(result.image, undefined);
  assert.deepEqual(calls.map(c => c.name), ['type_text']);
});

for (const mode of ['missing', 'malformed', 'throw', 'cancel'] as const) {
  test(`observation ${mode} preserves action evidence and last valid geometry without replay`, async () => {
    let captureCount = 0;
    const controller = new AbortController();
    const { session, calls } = fixture(name => {
      if (name !== 'get_desktop_state') return { data: { effect: 'dispatched' } };
      if (++captureCount === 1) return capture();
      if (mode === 'throw') throw new Error('mock capture failure');
      if (mode === 'cancel') controller.abort();
      if (mode === 'missing') return { data: {}, content: [] };
      if (mode === 'malformed') return { data: {}, content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] };
      return capture(1920, 1080);
    });
    const first = await session.execute('computer_window', '{}');
    const result = await session.execute('computer_action_and_screenshot', combination(), controller.signal);
    assert.equal(result.ok, false);
    assert.equal(result.action?.dispatch, 'dispatched');
    assert.equal(result.action?.businessSuccess, 'unverified');
    assert.equal(result.observation?.attempted, true);
    assert.equal(result.observation?.status, mode === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(result.image, undefined);
    assert.equal(result.screenshot, undefined);
    assert.match(result.text, /Do not replay/);
    assert.deepEqual(calls.map(c => c.name), ['get_desktop_state', 'click', 'get_desktop_state']);
    const status = await session.execute('computer_status', '{}');
    assert.equal(status.context?.lastCapture, mode === 'cancel' ? 'cancelled' : 'failed');
    assert.deepEqual(status.context?.lastScreenshot, first.screenshot);
  });
}

test('already cancelled and malformed action requests never connect or capture', async () => {
  const { session, calls, starts } = fixture();
  const invalid = await session.execute('computer_action_and_screenshot', combination('computer_click', { x: -1, y: 0 }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.action?.dispatch, 'not_dispatched');
  assert.equal(invalid.observation?.attempted, false);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await session.execute('computer_action_and_screenshot', combination(), controller.signal);
  assert.equal(cancelled.code, 'CANCELLED');
  assert.equal(cancelled.image, undefined);
  assert.equal(starts(), 0);
  assert.deepEqual(calls, []);
});

test('pause during lazy startup prevents capture and does not leave pending capture status', async () => {
  const { session, state, calls } = fixture();
  state.start = async () => { session.pause(); };
  const result = await session.execute('computer_window', '{}');
  assert.equal(result.ok, false);
  assert.equal(result.image, undefined);
  const status = await session.execute('computer_status', '{}');
  assert.equal(status.context?.lifecycle, 'paused');
  assert.equal(status.context?.lastCapture, 'failed');
  assert.deepEqual(calls, []);
});

test('real audit wrapper records phase outcomes but never screenshot bytes or context text', async () => {
  const { session } = fixture(name => name === 'get_desktop_state' ? capture() : { data: { effect: 'dispatched' } });
  const result = await session.execute('computer_action_and_screenshot', combination());
  assert.equal(result.ok, true);
  assert.deepEqual(session.audit.map(entry => [entry.tool, entry.outcome]), [['click', 'dispatched'], ['get_desktop_state', 'returned']]);
  assert(!JSON.stringify(session.audit).includes(result.image!));
  assert(!JSON.stringify(session.audit).includes('Computer context'));
  assert(!result.text.includes(result.image!));
});

test('Stop interrupts owned connection but permits a later lazy input without screenshot gate or replay', async () => {
  const controller = new AbortController();
  let stop = true;
  const { session, calls, starts } = fixture(() => {
    if (stop) { stop = false; controller.abort(); }
    return { data: { effect: 'dispatched' } };
  });
  const cancelled = await session.execute('computer_action_and_screenshot', combination(), controller.signal);
  assert.equal(cancelled.code, 'CANCELLED');
  assert.equal(cancelled.action?.dispatch, 'unknown');
  assert.equal(cancelled.observation?.attempted, false);
  assert.match(cancelled.text, /Observe the desktop again/);
  const status = await session.execute('computer_status', '{}');
  assert.equal(status.context?.lifecycle, 'active');
  assert.equal(status.context?.driver.connection, 'not_started');
  assert.equal(starts(), 1);
  const next = await session.execute('computer_type', '{"text":"next user action"}');
  assert.equal(next.ok, true);
  assert.equal(starts(), 2);
  assert.deepEqual(calls.map(c => c.name), ['click', 'type_text']);
});

test('Stop while startup is pending drains the old startup before a queued request reconnects', async () => {
  const controller = new AbortController();
  const { session, state, calls } = fixture();
  const client = state.client;
  const { promise: starting, resolve: started } = Promise.withResolvers<void>();
  const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
  let attempts = 0;
  state.start = async () => {
    if (++attempts === 1) { started(); await blocked; }
    state.client = client;
  };
  const first = session.execute('computer_action_and_screenshot', combination(), controller.signal);
  await starting;
  controller.abort();
  const next = session.execute('computer_type', '{"text":"fresh request"}');
  release();
  assert.equal((await first).code, 'CANCELLED');
  assert.equal((await next).ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(calls.map(c => c.name), ['type_text']);
});

test('explicit close during Stop remains terminal and cleanup is idempotent', async () => {
  const controller = new AbortController();
  const { session, calls, starts } = fixture(() => {
    controller.abort();
    void session.close();
    return { data: { effect: 'dispatched' } };
  });
  assert.equal((await session.execute('computer_type', '{"text":"first"}', controller.signal)).code, 'CANCELLED');
  const closed = session.close();
  assert.equal(session.close(), closed);
  await closed;
  assert.equal((await session.execute('computer_type', '{"text":"blocked"}')).ok, false);
  assert.equal((await session.execute('computer_status', '{}')).context?.lifecycle, 'closed');
  assert.equal(starts(), 1);
  assert.deepEqual(calls.map(c => c.name), ['type_text']);
});

test('pause during Stop remains terminal for input', async () => {
  const controller = new AbortController();
  const { session, starts } = fixture(() => {
    controller.abort();
    session.pause();
    return { data: { effect: 'dispatched' } };
  });
  await session.execute('computer_type', '{"text":"first"}', controller.signal);
  assert.equal((await session.execute('computer_type', '{"text":"blocked"}')).ok, false);
  assert.equal((await session.execute('computer_status', '{}')).context?.lifecycle, 'paused');
  assert.equal(starts(), 1);
});
