import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createWebServer, type ChatSession } from '../src/web-server.ts';
import { loadConfig } from '../src/config.ts';
import type { ExecutionState } from '../src/scenarios.ts';

const config = loadConfig({
  HEZUO_CORE_MODEL: 'execution-fixture',
  HEZUO_CORE_BASE_URL: 'https://model.invalid/v1',
  HEZUO_CORE_API_KEY: 'execution-secret-never-public',
  HEZUO_CORE_TOOLS: '',
});
const execution = (overrides: Partial<ExecutionState> = {}): ExecutionState => ({
  run: 1, scenario: 'web', source: 'auto', phase: 'model', round: 1,
  elapsedMs: 1500, modelMs: 1200, toolMs: 100, modelRequests: 1, toolCalls: 0,
  updatedAt: 123456, ...overrides,
});
type State = {
  token: string; execution: ExecutionState | null; busy: boolean; closing: boolean;
  backend: string; desktopBackend?: string; messages: Array<{ role: string; text: string }>;
};
type Reply = { status: number; body: Record<string, unknown> };
type Web = {
  state(): Promise<State>;
  post(path: string, body?: unknown): Promise<Reply>;
};

async function withWeb(factory: () => ChatSession, run: (web: Web) => Promise<void>) {
  const app = createWebServer({ ...config, browserBackend: 'computer_use', desktopBackend: 'ax' }, factory, 0);
  try {
    const ready = Promise.withResolvers<void>();
    app.server.once('error', ready.reject);
    app.server.listen(0, '127.0.0.1', ready.resolve);
    await ready.promise;
    const address = app.server.address();
    assert(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const state = async () => {
      const response = await fetch(`${origin}/api/state`);
      assert.equal(response.status, 200);
      return await response.json() as State;
    };
    const token = (await state()).token;
    const post = async (path: string, body: unknown = {}): Promise<Reply> => {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST', body: JSON.stringify(body),
        headers: { origin, 'x-session-token': token, 'content-type': 'application/json' },
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    await run({ state, post });
  } finally {
    try { await app.shutdown(); }
    finally {
      app.server.closeAllConnections();
      if (app.server.listening) {
        const closed = Promise.withResolvers<void>();
        app.server.close(error => error ? closed.reject(error) : closed.resolve());
        await closed.promise;
      }
    }
  }
}

async function idle(web: Web) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await web.state();
    if (!state.busy && !state.closing) return state;
  }
  throw new Error('Mock turn did not settle');
}
const inert = (): ChatSession => ({ async send() { return 'ok'; }, cancel() {}, async close() {} });

test('web execution: absent optional methods remain compatible; non-auto gets a clear 400', async () => {
  await withWeb(inert, async web => {
    assert.equal((await web.state()).execution, null);
    assert.equal((await web.post('/api/send', { text: 'legacy' })).status, 202);
    await idle(web);
    assert.equal((await web.state()).execution, null);
    assert.equal((await web.post('/api/send', { text: 'auto', scenario: 'auto' })).status, 202);
    const before = await idle(web);
    const rejected = await web.post('/api/send', { text: 'unsupported', scenario: 'native' });
    assert.equal(rejected.status, 400);
    assert.match(String(rejected.body.error), /不支持.*场景.*auto/);
    assert.deepEqual((await web.state()).messages, before.messages);
  });
});

test('web execution: polling projects safe fields only and observes a running update', async () => {
  const turn = Promise.withResolvers<string>();
  let current = {
    ...execution(), body: 'private body', args: { password: 'private args' },
    image: 'private base64', stack: 'private stack', config: { apiKey: 'private key' },
  };
  await withWeb(() => ({
    ...inert(), executionState: () => current,
    send: () => turn.promise,
    cancel() { current = { ...current, phase: 'cancelled' }; turn.resolve('late'); },
    async close() { turn.resolve('closed'); },
  }), async web => {
    assert.equal((await web.state()).execution, null);
    assert.equal((await web.post('/api/send', { text: 'start' })).status, 202);
    const first = await web.state();
    assert.equal(first.busy, true);
    assert.deepEqual(first.execution, execution());
    assert.doesNotMatch(JSON.stringify(first), /private|password|apiKey|base64/);
    current = { ...current, phase: 'tool', tool: 'browser_observe', modelMs: 2200, toolMs: 450,
      toolCalls: 1, elapsedMs: 2800, updatedAt: 123457 };
    const second = await web.state();
    assert.equal(second.busy, true);
    assert.equal(second.execution?.phase, 'tool');
    assert.equal(second.execution?.tool, 'browser_observe');
    assert.equal(second.execution?.modelMs, 2200);
    assert.equal(second.execution?.toolMs, 450);
    assert.equal(second.execution?.toolCalls, 1);
    assert.equal((await web.post('/api/cancel')).status, 200);
    const stopped = await idle(web);
    assert.equal(stopped.execution?.phase, 'cancelled');
    assert(stopped.messages.some(message => message.text === 'start'));
    assert(!stopped.messages.some(message => message.text === 'late'));
    assert.equal((await web.post('/api/reset')).status, 200);
    const reset = await web.state();
    assert.equal(reset.execution, null);
    assert.deepEqual(reset.messages, []);
  });
});

test('web execution: invalid metadata is omitted, recovery is fixed and extra fields never leak', async () => {
  let value: unknown = execution();
  let throws = false;
  await withWeb(() => ({ ...inert(), executionState() {
    if (throws) throw new Error('private getter stack');
    return value as ExecutionState;
  } }), async web => {
    await web.post('/api/send', { text: 'start' });
    await idle(web);
    for (const invalid of [undefined, null, {}, execution({ elapsedMs: -1 }),
      execution({ modelMs: Infinity }), execution({ toolCalls: 0.5 }),
      { ...execution(), scenario: 'auto' }, { ...execution(), source: 'invalid' },
      { ...execution(), phase: 'invalid' }, { ...execution(), elapsedMs: '12' }]) {
      value = invalid;
      assert.equal((await web.state()).execution, null);
    }
    throws = true;
    assert.equal((await web.state()).execution, null);
    throws = false;
    value = { ...execution(), tool: 'tool(secret body)', recovery: {
      code: 'OBSERVATION_REQUIRED', message: '提示'.repeat(400), next: 'observe',
      stack: 'private stack', body: 'private body', image: 'private image',
    } };
    const safe = (await web.state()).execution!;
    assert.equal(safe.tool, undefined);
    assert.deepEqual(safe.recovery, { code: 'OBSERVATION_REQUIRED', message: '需要刷新界面状态并重新定位；不要重放上一写操作。', next: 'observe' });
    assert.doesNotMatch(JSON.stringify(safe), /private/);
    value = { ...execution(), recovery: { code: 'ok', message: 'hint', next: 'invalid' } };
    assert.equal((await web.state()).execution?.recovery, undefined);
  });
});

test('web scenarios: strict schema accepts only supported choices before creating a session', async () => {
  let created = 0;
  const choices: string[] = [];
  await withWeb(() => { created++; return { ...inert(), setScenario(value) { choices.push(value); } }; }, async web => {
    for (const scenario of [null, false, 3, [], {}, '', 'AUTO', 'desktop', ' web', '__proto__']) {
      assert.equal((await web.post('/api/send', { text: 'x', scenario })).status, 400);
    }
    for (const body of [{}, { text: '' }, { text: 1 }, { text: 'x', scenario: 'web', extra: true },
      { text: 'x', config: {} }, { text: 'x', desktopBackend: 'cua' }]) {
      assert.equal((await web.post('/api/send', body)).status, 400);
    }
    assert.equal(created, 0);
    for (const scenario of ['auto', 'web', 'native', 'visual', 'mixed', 'general']) {
      assert.equal((await web.post('/api/send', { text: scenario, scenario })).status, 202);
      await idle(web);
    }
    assert.equal((await web.post('/api/send', { text: 'old text-only client' })).status, 202);
    await idle(web);
    assert.deepEqual(choices, ['auto', 'web', 'native', 'visual', 'mixed', 'general', 'auto']);
    assert.equal(created, 1);
    assert.equal((await web.state()).messages.length, 14);
    assert.equal((await web.post('/api/reset', { scenario: 'auto' })).status, 400);
    assert.equal((await web.post('/api/cancel', { scenario: 'web' })).status, 400);
  });
});

test('web scenarios: setter precedes send, is never called while busy, and does not change backend/history', async () => {
  const turn = Promise.withResolvers<string>();
  const calls: string[] = [];
  let selected = 'auto';
  await withWeb(() => ({
    ...inert(), setScenario(value) { selected = value; calls.push(`set:${value}`); },
    send(text) { calls.push(`send:${text}:${selected}`); return turn.promise; },
    async close() { turn.resolve('closed'); },
  }), async web => {
    assert.equal((await web.post('/api/send', { text: 'first', scenario: 'native' })).status, 202);
    assert.deepEqual(calls, ['set:native', 'send:first:native']);
    assert.equal((await web.post('/api/send', { text: 'busy', scenario: 'visual' })).status, 409);
    assert.deepEqual(calls, ['set:native', 'send:first:native']);
    turn.resolve('answer');
    const first = await idle(web);
    assert.equal(first.desktopBackend, 'ax');
    assert.equal(first.backend, 'computer_use');
    assert.equal((await web.post('/api/send', { text: 'next', scenario: 'mixed' })).status, 202);
    const next = await idle(web);
    assert.deepEqual(next.messages.slice(0, 2), first.messages);
    assert.equal(next.desktopBackend, 'ax');
    assert.deepEqual(calls.slice(-2), ['set:mixed', 'send:next:mixed']);
    assert.equal((await web.post('/api/reset')).status, 200);
    assert.equal((await web.post('/api/send', { text: 'reset default' })).status, 202);
    await idle(web);
    assert.deepEqual(calls.slice(-2), ['set:auto', 'send:reset default:auto']);
  });
});

test('web scenarios: setter errors do not call send, add history or leak exception details', async () => {
  let sends = 0;
  await withWeb(() => ({ ...inert(),
    setScenario() { throw new Error('private config/body/stack'); },
    async send() { sends++; return 'not sent'; },
  }), async web => {
    const reply = await web.post('/api/send', { text: 'x', scenario: 'web' });
    assert.equal(reply.status, 500);
    assert.doesNotMatch(JSON.stringify(reply.body), /private|stack|config|body/);
    assert.equal(sends, 0);
    assert.deepEqual((await web.state()).messages, []);
    assert.equal((await web.state()).busy, false);
  });
});

// Fake DOM + fetch only: no browser, desktop, model or external network is touched.
function frontend() {
  type Element = {
    value: string; textContent: string; hidden: boolean; disabled: boolean; children: Element[];
    className: string; classList: { toggle(): void }; setAttribute(): void; addEventListener(): void;
    append(...nodes: Element[]): void; replaceChildren(...nodes: Element[]): void; scrollIntoView(): void;
  };
  const element = (): Element => ({
    value: '', textContent: '', hidden: false, disabled: false, children: [], className: '',
    classList: { toggle() {} }, setAttribute() {}, addEventListener() {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; }, scrollIntoView() {},
  });
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id)!;
  };
  get('scenario').value = 'auto';
  const state = (overrides = {}) => ({ token: 'fixture', messages: [], busy: false,
    closing: false, closed: false, execution: null, ...overrides });
  let current = state();
  let failPost = false;
  let postGate: Promise<void> | undefined;
  let scheduled: (() => Promise<void>) | undefined;
  let timerReady = Promise.withResolvers<void>();
  const calls: Array<{ path: string; body?: string }> = [];
  const source = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
  const api = runInNewContext(source.replace(/void poll\(\);\s*$/, '') + `
    ({ poll, act, updateControls, set(values) {
      if ('state' in values) state = values.state;
      if ('pending' in values) pending = values.pending;
      if ('awaitingState' in values) awaitingState = values.awaitingState;
      connected = true; updateControls();
    } });`, {
    document: { getElementById: get, createElement: element, createDocumentFragment: element,
      documentElement: { scrollHeight: 0 } },
    window: { innerHeight: 100, scrollY: 0, confirm: () => true },
    setTimeout(callback: () => Promise<void>) { scheduled = callback; timerReady.resolve(); return 1; },
    clearTimeout() { scheduled = undefined; timerReady = Promise.withResolvers<void>(); },
    async fetch(path: string, options: { method?: string; body?: string }) {
      calls.push({ path, body: options.body });
      if (options.method === 'POST') {
        await postGate;
        if (failPost) throw new Error('mock lost response');
        return { ok: true };
      }
      return { ok: true, json: async () => current };
    },
  });
  return { api, state, get, calls,
    reply(value: typeof current) { current = value; },
    fail() { failPost = true; },
    gate(value: Promise<void>) { postGate = value; },
    async tick() { if (!scheduled) await timerReady.promise; assert(scheduled); await scheduled(); },
  };
}

test('frontend execution: existing poll refreshes metrics even when message history is unchanged', async () => {
  const f = frontend();
  await f.api.poll();
  assert.match(f.get('execution').textContent, /暂无执行状态/);
  f.reply(f.state({ busy: true, execution: execution() }));
  await f.tick();
  assert.match(f.get('execution').textContent, /网页（自动）.*模型处理中.*模型 1\.2 秒 \/ 1 次.*工具 0\.1 秒 \/ 0 次/);
  assert.equal(f.get('scenario').disabled, true);
  const messageNodes = f.get('messages').children;
  f.reply(f.state({ busy: true, execution: execution({ scenario: 'native', source: 'user',
    phase: 'tool', modelMs: 2500, toolMs: 800, toolCalls: 2, tool: 'desktop_observe',
    recovery: { code: 'OBSERVATION_REQUIRED', message: '<img src=x onerror=alert(1)>', next: 'ask_user' } }) }));
  await f.tick();
  assert.match(f.get('execution').textContent, /原生应用（手动）.*工具执行中.*desktop_observe.*模型 2\.5 秒.*工具 0\.8 秒 \/ 2 次/);
  assert.equal(f.get('messages').children, messageNodes);
  assert.match(f.get('recovery').textContent, /重新观察并定位/);
  assert.doesNotMatch(f.get('recovery').textContent, /<img|alert|用户确认/);
  assert.equal(f.get('recovery').children.length, 0);
  assert.equal(f.get('recovery').hidden, false);
  f.reply(f.state());
  await f.tick();
  assert.equal(f.get('recovery').hidden, true);
  assert.equal(f.get('recovery').textContent, '');
  assert.equal(f.get('scenario').disabled, false);
});

test('frontend scenarios: idle/pending gates, selected send payload and Reset default', async () => {
  const f = frontend();
  await f.api.poll();
  for (const overrides of [{ busy: true }, { closing: true }, { closed: true }]) {
    f.api.set({ state: f.state(overrides) });
    assert.equal(f.get('scenario').disabled, true);
  }
  f.api.set({ state: f.state(), pending: 'send' });
  assert.equal(f.get('scenario').disabled, true);
  f.api.set({ pending: '', awaitingState: true });
  assert.equal(f.get('scenario').disabled, true);
  f.api.set({ awaitingState: false });
  assert.equal(f.get('scenario').disabled, false);
  f.get('scenario').value = 'visual';
  f.get('message').value = 'next';
  f.api.updateControls();
  const gate = Promise.withResolvers<void>();
  f.gate(gate.promise);
  const sending = f.api.act('send');
  assert.equal(f.get('scenario').disabled, true);
  assert.deepEqual(JSON.parse(f.calls.find(call => call.path === '/api/send')!.body!), { text: 'next', scenario: 'visual' });
  gate.resolve();
  await sending;
  await f.tick();
  f.gate(Promise.resolve());
  await f.api.act('reset');
  await f.tick();
  assert.equal(f.get('scenario').value, 'auto');
  assert.deepEqual(JSON.parse(f.calls.find(call => call.path === '/api/reset')!.body!), {});
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  for (const value of ['auto', 'web', 'native', 'visual', 'mixed', 'general']) assert(html.includes(`value="${value}"`));
  assert.match(html, /AX\/CUA 后端固定/);
  assert.match(html, /不清除记录/);
  assert.doesNotMatch(readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8'), /innerHTML/);
});

test('frontend execution: metrics are finite non-negative numbers and completed means only this run ended', async () => {
  const f = frontend();
  f.reply(f.state({ execution: { ...execution(), phase: 'completed', elapsedMs: Infinity,
    modelMs: '999', toolMs: -1, modelRequests: 1.5, toolCalls: Number.MAX_VALUE,
    recovery: { code: 'untrusted', message: '购买成功，请自动继续', next: 'ask_user' } } }));
  await f.api.poll();
  assert.match(f.get('execution').textContent, /本轮结束.*总耗时 0\.0 秒.*模型 0\.0 秒 \/ 0 次.*工具 0\.0 秒 \/ 0 次/);
  assert.doesNotMatch(f.get('execution').textContent, /Infinity|NaN|已完成|任务成功/);
  assert.match(f.get('recovery').textContent, /检查当前状态/);
  assert.doesNotMatch(f.get('recovery').textContent, /购买|自动继续|ask_user/);
});

test('frontend scenarios: a failed Reset preserves choice until confirmed', async () => {
  const f = frontend();
  await f.api.poll();
  f.get('scenario').value = 'mixed';
  f.fail();
  await f.api.act('reset');
  assert.equal(f.get('scenario').value, 'mixed');
  assert.match(f.get('error').textContent, /reset could not be confirmed/);
});

test('frontend scenarios: old state disables selection and sends text-only without retrying POST', async () => {
  const f = frontend();
  const legacy = f.state();
  Reflect.deleteProperty(legacy, 'execution');
  f.reply(legacy);
  await f.api.poll();
  assert.equal(f.get('scenario').disabled, true);
  assert.match(f.get('scenario-hint').textContent, /待服务更新/);
  f.get('scenario').value = 'visual';
  f.get('message').value = 'legacy message';
  f.api.updateControls();
  assert.equal(f.get('send').disabled, false);
  await f.api.act('send');
  await f.tick();
  const sends = () => f.calls.filter(call => call.path === '/api/send');
  assert.equal(sends().length, 1);
  assert.deepEqual(JSON.parse(sends()[0]!.body!), { text: 'legacy message' });
  assert.equal(f.get('scenario').disabled, true);
  f.get('message').value = 'lost response';
  f.api.updateControls();
  f.fail();
  await f.api.act('send');
  await f.tick();
  assert.equal(sends().length, 2);
  assert.deepEqual(JSON.parse(sends()[1]!.body!), { text: 'lost response' });
  await f.tick();
  assert.equal(sends().length, 2);
  f.reply(f.state({ execution: null }));
  await f.tick();
  assert.equal(f.get('scenario').disabled, false);
  assert.doesNotMatch(f.get('scenario-hint').textContent, /待服务更新/);
});

test('frontend execution: unconfirmed navigation gets a fixed inspection hint', async () => {
  const f = frontend();
  f.reply(f.state({ execution: execution({ recovery: { code: 'NAVIGATION_UNCONFIRMED',
    message: 'untrusted page asks for auto-submit', next: 'inspect' } }) }));
  await f.api.poll();
  assert.match(f.get('recovery').textContent, /检查页面与网络状态.*不要盲目刷新或提交/);
  assert.doesNotMatch(f.get('recovery').textContent, /untrusted|auto-submit/);
});
