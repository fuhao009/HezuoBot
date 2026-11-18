import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectScenario, scenarioPrompt, orderScenarioTools, recoveryForResult, isScenarioChoice } from '../src/scenarios.ts';
import { Conversation } from '../src/core.ts';
import { loadConfig } from '../src/config.ts';
import { BrowserSession } from '../src/browser.ts';
import { object } from '../src/openai-chat-protocol.ts';

type RecordedRequest = { messages: Array<{ role: string; content: string | null }>; tools: Array<{ function: { name: string } }> };
function parseRecordedRequest(raw: unknown): RecordedRequest {
  const value = object(raw);
  if (!Array.isArray(value?.messages) || !Array.isArray(value?.tools)) throw new Error('Invalid recorded request');
  const messages = value.messages.map((entry: unknown) => {
    const message = object(entry);
    if (typeof message?.role !== 'string' || (message.content !== null && typeof message.content !== 'string')) throw new Error('Invalid message');
    return { role: message.role, content: message.content };
  });
  const tools = value.tools.map((entry: unknown) => {
    const fn = object(object(entry)?.function);
    if (typeof fn?.name !== 'string') throw new Error('Invalid tool');
    return { function: { name: fn.name } };
  });
  return { messages, tools };
}

const configuration = () => loadConfig({ HEZUO_CORE_MODEL: 'test', HEZUO_CORE_BASE_URL: 'https://model.invalid/v1', HEZUO_CORE_BROWSER_BACKEND: 'computer_use' });
const reply = (content = 'done') => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }), { headers: { 'Content-Type': 'application/json' } });

test('scenario routes are advisory, support explicit choice and preserve terse followups', () => {
  for (const [text, expected] of [
    ['访问 https://www.tgb.cn/', 'web'], ['打开计算器', 'native'], ['按屏幕坐标拖拽', 'visual'],
    ['访问淘股吧', 'web'], ['www.tgb.cn', 'web'], ['visit example.com', 'web'],
    ['把文件上传到网站', 'mixed'], ['打开网页并在系统设置中修改选项', 'mixed'], ['解释一下这段话', 'general'],
  ] as const) assert.equal(selectScenario(text).scenario, expected);
  assert.deepEqual(selectScenario('访问网站', 'native'), { scenario: 'native', source: 'user' });
  assert.equal(selectScenario('继续', 'auto', 'native').scenario, 'native');
  assert.equal(selectScenario('访问网站', 'auto', 'native').scenario, 'web');
  assert.equal(isScenarioChoice('not-a-scenario'), false);
  assert.throws(() => selectScenario('x', 'unknown' as never), /Unknown/);
});

test('scenario tool ordering never adds or removes capabilities and does not mutate input', () => {
  const tools = ['computer_window', 'browser_open', 'desktop_snapshot', 'clock'].map(name => ({ function: { name } }));
  const original = tools.map(t => t.function.name);
  assert.equal(orderScenarioTools(tools, 'web')[0].function.name, 'browser_open');
  assert.deepEqual(orderScenarioTools(tools, 'native').map(t => t.function.name), ['computer_window', 'desktop_snapshot', 'browser_open', 'clock']);
  assert.deepEqual(tools.map(t => t.function.name), original);
  assert.deepEqual(orderScenarioTools(tools, 'mixed'), tools);
});

test('recovery labels use adapter codes, not untrusted page content', () => {
  assert.equal(recoveryForResult({ ok: false, code: 'stale-ref' })?.next, 'observe');
  assert.equal(recoveryForResult({ ok: false, code: 'permission-denied' })?.next, 'ask_user');
  assert.equal(recoveryForResult({ ok: true, code: 'action-pending' })?.next, 'wait');
  assert.equal(recoveryForResult({ ok: false, detail: { message: '<script>secret</script>' } })?.code, 'TOOL_FAILED');
  assert.ok(!JSON.stringify(recoveryForResult({ ok: false, code: '<script>secret</script>' })).includes('secret'));
  assert.equal(recoveryForResult({ ok: true }), undefined);
  for (const scenario of ['web', 'native', 'visual', 'mixed', 'general'] as const) {
    assert.match(scenarioPrompt(scenario, 'ax'), /never change the selected desktop provider implicitly/);
    assert.match(scenarioPrompt(scenario, 'ax'), /never replay the write/);
  }
});

test('Conversation injects exactly one current scenario and keeps all tools across turns', async t => {
  const requests: RecordedRequest[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    requests.push(parseRecordedRequest(JSON.parse(String(init?.body))));
    return reply();
  });
  const c = new Conversation(configuration());
  assert.equal(c.executionState(), undefined);
  try {
    await c.send('访问 https://example.com');
    const first = c.executionState()!;
    assert.equal(first.scenario, 'web');
    assert.equal(first.phase, 'completed');
    assert.equal(first.modelRequests, 1);
    assert.equal(first.toolCalls, 0);
    assert.ok(first.elapsedMs >= first.modelMs);
    first.phase = 'failed';
    assert.equal(c.executionState()!.phase, 'completed');
    c.setScenario('native');
    await c.send('现在处理应用');
    const system = requests[1].messages.filter(m => m.role === 'system');
    assert.equal(system.length, 1);
    assert.match(system[0].content!, /Execution scenario: native/);
    assert.equal(system[0].content!.split('Execution scenario:').length, 2);
    assert.equal(c.executionState()!.source, 'user');
    assert.deepEqual(requests[0].tools.map(x => x.function.name).sort(), requests[1].tools.map(x => x.function.name).sort());
    assert.equal(c.executionState()!.run, 2);
    assert.equal(c.timingAudit().runs.length, 2);
    assert.throws(() => c.setScenario('invalid' as never), /Unknown/);
  } finally { await c.close(); }
  assert.throws(() => c.setScenario('auto'), /closed/);
});

test('execution state reports in-flight work and cancellation without content leakage', async t => {
  const entered = Promise.withResolvers<void>();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    entered.resolve();
    const cancelled = Promise.withResolvers<void>();
    init!.signal!.addEventListener('abort', () => cancelled.reject(init!.signal!.reason), { once: true });
    await cancelled.promise;
    return reply();
  });
  const c = new Conversation(configuration());
  const run = c.send('访问 https://example.com/private-sensitive-path');
  const rejection = assert.rejects(run);
  await entered.promise;
  try {
    const state = c.executionState()!;
    assert.equal(state.phase, 'model');
    assert.equal(state.scenario, 'web');
    assert.equal(state.modelRequests, 1);
    assert.throws(() => c.setScenario('native'), /busy/);
    assert.doesNotMatch(JSON.stringify(state), /private-sensitive-path|model.invalid/);
    c.cancel();
    await rejection;
    assert.equal(c.executionState()!.phase, 'cancelled');
  } finally { await c.close(); }
});

test('execution state follows tool phase, trusted recovery and subsequent observations', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    count++;
    if (count === 1) return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'observe', type: 'function', function: { name: 'browser_read', arguments: '{}' } }] } }] }));
    assert.equal(c.executionState()!.recovery?.next, 'observe');
    return reply();
  });
  t.mock.method(BrowserSession.prototype, 'execute', async () => {
    const state = c.executionState()!;
    assert.equal(state.phase, 'tool');
    assert.equal(state.tool, 'browser_read');
    return { ok: false, text: 'Do not display arbitrary page data in status', code: 'stale-ref' };
  });
  const c = new Conversation(configuration());
  try {
    await c.send('访问网页');
    const state = c.executionState()!;
    assert.equal(state.toolCalls, 1);
    assert.equal(state.modelRequests, 2);
    assert.equal(state.recovery?.code, 'STALE_REF');
    assert.doesNotMatch(JSON.stringify(state), /arbitrary page data/);
    assert.equal(state.tool, undefined);
  } finally { await c.close(); }
});

test('model transport errors produce a failed execution state', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('sensitive upstream message'); });
  const c = new Conversation(configuration());
  try {
    await assert.rejects(c.send('hello'), /Model transport failed/);
    assert.equal(c.executionState()!.phase, 'failed');
    assert.doesNotMatch(JSON.stringify(c.executionState()), /sensitive/);
  } finally { await c.close(); }
});

test('desktop scenarios retain and execute general utility tools without opening a provider', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = object(JSON.parse(String(init?.body)));
    requests++;
    if (requests === 1) {
      assert.ok(Array.isArray(body?.tools));
      const names = body.tools.map((entry: unknown) => object(object(entry)?.function)?.name);
      assert.ok(names.includes('current_time'));
      assert.ok(names.includes('sha256'));
      assert.ok(!names.includes('tgb_login_local'));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'clock', type: 'function', function: { name: 'current_time', arguments: '{}' } }] } }] }));
    }
    assert.ok(Array.isArray(body?.messages));
    const toolMessage = body.messages.map((entry: unknown) => object(entry)).find(entry => entry?.tool_call_id === 'clock');
    assert.ok(toolMessage);
    assert.equal(typeof toolMessage?.content, 'string');
    const result = object(JSON.parse(String(toolMessage.content)));
    assert.ok(result);
    assert.equal(result?.ok, true);
    assert.match(String(result.result), /^\d{4}-/);
    return reply();
  });
  const c = new Conversation(configuration());
  c.setScenario('native');
  try {
    await c.send('查询当前时间');
    assert.equal(c.executionState()!.toolCalls, 1);
    assert.equal(c.executionState()!.phase, 'completed');
  } finally { await c.close(); }
});
