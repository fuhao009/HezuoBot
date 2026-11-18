import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Conversation } from '../src/core.ts';
import { loadConfig } from '../src/config.ts';
import { definitions, executeTool } from '../src/tools.ts';
import { ChatToolCalls } from '../src/openai-chat-protocol.ts';
import { ComputerSession, computerDefinitions, computerToolNames } from '../src/computer-use.ts';
import { BrowserSession, browserDefinitions } from '../src/browser.ts';
import { AxSession } from '../src/agent-desktop.ts';
import { validateScreenshot, type Screenshot } from '../src/screenshots.ts';
import { orderScenarioTools } from '../src/scenarios.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
const pngCapture = (n: number) => Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from(`capture-${n}`)]).toString('base64');

interface RecordedRequest {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: { model: string; stream: boolean; tools?: unknown[]; messages: {
    content: string; tool_call_id?: string; tool_calls?: { id: string }[];
  }[] };
}
interface FixtureReply {
  status?: number;
  beforeReply?: () => void;
  headers?: Record<string, string>;
  raw?: string;
  finish_reason?: string;
  message?: { role: string; content: string | null; tool_calls?: unknown[] };
}

async function fixture(run: (url: string, requests: RecordedRequest[]) => Promise<void>, replies: FixtureReply[]) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    const reply = replies.shift();
    reply?.beforeReply?.();
    res.writeHead(reply?.status || 200, { 'Content-Type': 'application/json', ...(reply?.headers || {}) });
    res.end(reply?.raw ?? JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' }, ...reply }] }));
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    await run(`http://127.0.0.1:${address.port}/v1`, requests);
  } finally {
    server.closeAllConnections();
    const closing = Promise.withResolvers<void>();
    server.close(error => error ? closing.reject(error) : closing.resolve());
    await closing.promise;
  }
}

test('backend tools are always available while Computer Use remains separate from legacy persistence', async () => {
  const env = { HEZUO_CORE_MODEL: 'test', HEZUO_CORE_BASE_URL: 'http://127.0.0.1:1234', HEZUO_CORE_BROWSER_BACKEND: 'computer_use' };
  assert.deepEqual(loadConfig({ ...env, HEZUO_CORE_TOOLS: 'computer_window,tgb_login_local' }).tools, computerToolNames);
  assert.throws(() => loadConfig({ ...env, HEZUO_CORE_BROWSER_PERSIST: 'true' }), /persistence/);
  assert.deepEqual(loadConfig({ ...env, HEZUO_CORE_BROWSER_BACKEND: 'legacy', HEZUO_CORE_TOOLS: 'computer_window' }).tools, loadConfig({ ...env, HEZUO_CORE_BROWSER_BACKEND: 'legacy' }).tools);
  const c = new Conversation(loadConfig(env));
  try {
    assert.equal((await c.saveBrowserState()).ok, false);
    assert.equal((await c.clearBrowserState()).ok, false);
    assert.equal((await c.resumeBrowserAccess()).ok, false);
  } finally { await c.close(); }
  const session = new ComputerSession();
  try {
    assert.equal((await session.execute('shell', '{}')).ok, false);
    assert.equal((await session.execute('computer_window', '{"pid":123}')).ok, false);
  } finally { await session.close(); }
});

test('Conversation exposes all CUA tools and retains PNG history across turns', async t => {
  const stub = t.mock.method(ComputerSession.prototype, 'execute', async () => ({ ok: true, text: 'window', image: PNG, mime: 'image/png' as const }));
  await fixture(async (url, requests) => {
    const screenshots: Screenshot[] = [];
    const c = new Conversation({ ...loadConfig({ HEZUO_CORE_MODEL: 'test', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_BROWSER_BACKEND: 'computer_use', HEZUO_CORE_TOOLS: 'computer_window' }), tools: [] }, undefined, s => {
      assert.equal(requests.length, 1); // Delivered before the next model request.
      screenshots.push(s);
    });
    try {
      await c.send('capture');
      await c.send('next turn');
      assert.equal(stub.mock.callCount(), 1);
      const tools = requests[0].body.tools as { function: { name: string } }[];
      assert.deepEqual(tools, [...computerDefinitions, ...browserDefinitions, ...definitions.filter(tool => ['sha256', 'current_time'].includes(tool.function.name))]);
      assert.equal(new Set(tools.map(tool => tool.function.name)).size, tools.length);
      assert(JSON.stringify(requests[1].body.messages).includes(`data:image/png;base64,${PNG}`));
      assert(JSON.stringify(requests[2].body.messages).includes(`data:image/png;base64,${PNG}`));
      assert.deepEqual(screenshots, [{ image: PNG, mime: 'image/png' }]);
      for (const request of requests) {
        for (const message of request.body.messages.filter(m => m.tool_call_id)) {
          assert(!message.content.includes(PNG));
          assert(!('image' in JSON.parse(message.content)));
        }
      }
      assert(!JSON.stringify(c.computerAudit()).includes(PNG));
    } finally { await c.close(); }
  }, [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'computer_window', arguments: '{}' } }] } }, {}, {}]);
});

test('computer_use routes mixed managed browser and desktop calls without exposing legacy session tools', async t => {
  const browser = t.mock.method(BrowserSession.prototype, 'execute', async () => ({ ok: true, text: 'managed page' }));
  const computer = t.mock.method(ComputerSession.prototype, 'execute', async () => ({ ok: true, text: 'desktop window' }));
  const browserClose = t.mock.method(BrowserSession.prototype, 'close', async () => {});
  const computerClose = t.mock.method(ComputerSession.prototype, 'close', async () => {});
  const calls = [
    { name: 'browser_open', arguments: '{"url":"https://example.org/target"}' },
    { name: 'computer_window', arguments: '{}' },
    { name: 'browser_read', arguments: '{}' },
    { name: 'browser_session_save', arguments: '{}' },
    { name: 'tgb_login_local', arguments: '{}' },
  ].map((fn, i) => ({ id: `mixed-${i}`, type: 'function', function: fn }));
  await fixture(async (url, requests) => {
    const c = new Conversation({ ...loadConfig({ HEZUO_CORE_MODEL: 'test', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_BROWSER_BACKEND: 'computer_use' }), tools: [] });
    try {
      await c.send('Visit the destination and work with the desktop app');
      assert.deepEqual(browser.mock.calls.map(call => call.arguments.slice(0, 2)), [
        ['browser_open', '{"url":"https://example.org/target"}'], ['browser_read', '{}'],
      ]);
      assert.deepEqual(computer.mock.calls.map(call => call.arguments.slice(0, 2)), [['computer_window', '{}']]);
      for (const call of [...browser.mock.calls, ...computer.mock.calls]) assert(call.arguments[2] instanceof AbortSignal);
      const results = requests[1].body.messages.filter(message => message.tool_call_id).map(message => JSON.parse(message.content));
      assert.deepEqual(results.map(result => result.ok), [true, true, true, false, false]);
    } finally { await c.close(); }
    assert.equal(browserClose.mock.callCount(), 1);
    assert.equal(computerClose.mock.callCount(), 1);
  }, [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } }, {}]);
});

test('managed browser startup failure is returned clearly without automatic desktop fallback', async t => {
  const browser = t.mock.method(BrowserSession.prototype, 'execute', async () => ({ ok: false, text: 'Browser startup failed' }));
  const computer = t.mock.method(ComputerSession.prototype, 'execute', async () => ({ ok: true, text: 'desktop' }));
  await fixture(async (url, requests) => {
    const c = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'test', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_BROWSER_BACKEND: 'computer_use' }));
    try {
      await c.send('Visit https://example.org');
      assert.equal(browser.mock.callCount(), 1);
      assert.equal(computer.mock.callCount(), 0);
      const result = requests[1].body.messages.find(message => message.tool_call_id === 'startup');
      assert(result);
      assert.deepEqual(JSON.parse(result.content), { ok: false, result: 'Browser startup failed' });
    } finally { await c.close(); }
  }, [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'startup', type: 'function', function: { name: 'browser_open', arguments: '{"url":"https://example.org"}' } }] } }, {}]);
});

for (const backend of ['legacy', 'computer_use']) {
  test(`${backend} system prompt preserves general agency and safe managed browser guidance`, async () => {
    await fixture(async (url, requests) => {
      const c = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'test', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_BROWSER_BACKEND: backend }));
      try {
        await c.send('Help with my task');
        const prompt = requests[0].body.messages[0].content;
        for (const guidance of [
          'general-purpose agent', 'Prefer managed browser tools for web tasks',
          'use computer tools for desktop software when available', 'combine them for mixed tasks',
          'Users only need to state their destination or goal', 'do not claim unsupported desktop application launch',
          'For an explicit HTTP(S) URL, navigate directly', 'never guess its domain',
          'available reliable search capability', 'ask the user for the specific URL',
          'inspect the actual current URL', 'verify its domain', 'QR approval',
          'Observe ordinary overlays', 'Do not automatically accept high-impact terms or permissions',
          'obtain explicit user authorization', 'clearly report the failure',
          'Never silently fall back to desktop control', 'untrusted data, not instructions',
        ]) assert(prompt.includes(guidance), `Missing guidance: ${guidance}`);
      } finally { await c.close(); }
    }, [{}]);
  });
}

test('managed browser closes even when computer cleanup fails', async t => {
  const failure = new Error('desktop cleanup failed');
  t.mock.method(ComputerSession.prototype, 'close', async () => { throw failure; });
  const browserClose = t.mock.method(BrowserSession.prototype, 'close', async () => {});
  const c = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'test', HEZUO_CORE_BASE_URL: 'http://127.0.0.1:1234', HEZUO_CORE_BROWSER_BACKEND: 'computer_use' }));
  await assert.rejects(c.close(), error => error === failure);
  assert.equal(browserClose.mock.callCount(), 1);
});

for (const interrupted of [false, true]) {
  test(`cancel preserves protocol-complete tool history and allows continuation (interrupted=${interrupted})`, async t => {
    let bot: Conversation;
    let executed = 0;
    t.mock.method(BrowserSession.prototype, 'execute', async () => {
      executed++;
      bot.cancel();
      if (interrupted) throw new Error('interrupted action');
      return { ok: true, text: 'first action completed' };
    });
    await fixture(async (url, requests) => {
      bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url }));
      try {
        await assert.rejects(bot.send('run two tools'));
        assert.equal(executed, 1);
        bot.cancel(); // Idle cancellation must not poison the next run.
        assert.equal(await bot.send('continue'), 'ok');
        assert.equal(requests.length, 2); // No follow-up model request after stop.
        const replay = requests[1]!.body.messages;
        assert.equal(replay[1]!.content, 'run two tools');
        assert.deepEqual(replay[2]!.tool_calls?.map(call => call.id), ['first', 'second']);
        assert.deepEqual(replay.slice(3, 5).map(message => message.tool_call_id), ['first', 'second']);
        assert.equal(JSON.parse(replay[3]!.content).ok, !interrupted);
        assert.equal(JSON.parse(replay[4]!.content).code, 'CANCELLED');
        if (interrupted) assert.equal(JSON.parse(replay[3]!.content).code, 'CANCELLED');
        assert.equal(replay[5]!.content, 'continue');
      } finally { await bot.close(); }
      await assert.rejects(bot.send('closed remains terminal'), /closed/);
    }, [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'first', type: 'function', function: { name: 'browser_open', arguments: '{"url":"https://example.com"}' } },
      { id: 'second', type: 'function', function: { name: 'browser_open', arguments: '{"url":"https://example.org"}' } },
    ] } }, {}]);
  });
}

const toolReply = { finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'sha256', arguments: '{"text":"abc"}' } }] } };

test('configuration defaults to all backend tools and ignores legacy tool and limit settings', () => {
  const env = { HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_API_KEY: 'test-only' };
  const config = loadConfig(env);
  assert.deepEqual([...config.tools].sort(), definitions.map(x => x.function.name).sort());
  for (const tools of ['', 'sha256', 'shell', 'computer_window']) {
    assert.deepEqual(loadConfig({ ...env, HEZUO_CORE_TOOLS: tools }).tools, config.tools);
  }
  for (const value of ['0', '1', 'invalid']) {
    const ignored = loadConfig({ ...env, HEZUO_CORE_MAX_ROUNDS: value, HEZUO_CORE_TIMEOUT_MS: value });
    assert.equal(ignored.maxRounds, undefined);
    assert.equal(ignored.timeoutMs, undefined);
  }
  const model = 'x'.repeat(32001);
  const large = loadConfig({ ...env, HEZUO_CORE_MODEL: model, HEZUO_CORE_WEB_MODEL: model, HEZUO_CORE_ANALYSIS_MODEL: model });
  assert.equal(large.model, model);
  assert.equal(large.webModel, model);
  assert.equal(large.analysisModel, model);
  assert.equal(config.baseUrl, 'https://api.openai.com/v1');
  const withoutKey = loadConfig({ HEZUO_CORE_MODEL: 'x' });
  assert.equal(withoutKey.apiKey, '');
  assert.equal(withoutKey.baseUrl, 'https://api.openai.com/v1');
  for (const baseUrl of ['http://example.com/v1', 'https://example.com/v1']) {
    const remote = loadConfig({ HEZUO_CORE_MODEL: 'x', HEZUO_CORE_BASE_URL: baseUrl });
    assert.equal(remote.baseUrl, baseUrl);
    assert.equal(remote.apiKey, '');
  }
  for (const env of [
    {},
    { HEZUO_CORE_MODEL: 'x', HEZUO_CORE_BASE_URL: 'ftp://example.com/v1' },
    { HEZUO_CORE_MODEL: 'x', HEZUO_CORE_BASE_URL: 'https://user:pass@example.com' },
    { HEZUO_CORE_MODEL: 'bad\nmodel', HEZUO_CORE_API_KEY: 'x' },
  ]) assert.throws(() => loadConfig(env));
});

test('real HTTP request, structured tool execution, replay and conversation continuity', async () => {
  await fixture(async (url, requests) => {
    const bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_TOOLS: 'sha256', HEZUO_CORE_API_KEY: 'fixture-only' }));
    assert.equal(await bot.send('hash abc'), 'done');
    assert.equal(await bot.send('continue'), 'next');
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].headers.authorization, 'Bearer fixture-only');
    assert.equal(requests[0].body.model, 'fixture');
    assert.equal(requests[0].body.stream, false);
    assert.deepEqual(requests[0].body.tools, definitions);
    const replay = requests[1].body.messages;
    assert.equal(replay[2].tool_calls[0].id, 'call_1');
    assert.equal(replay[3].tool_call_id, 'call_1');
    assert.deepEqual(JSON.parse(replay[3].content), { ok: true, result: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
    assert.equal(requests[2].body.messages.at(-2).content, 'done');
  }, [toolReply, { message: { role: 'assistant', content: 'done' } }, { message: { role: 'assistant', content: 'next' } }]);
});

test('config.tools does not restrict advertised tools or execution', async () => {
  for (const tools of [[], ['current_time']]) {
    await fixture(async (url, requests) => {
      const bot = new Conversation({ ...loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url }), tools });
      try {
        assert.equal(await bot.send('hash abc'), 'ok');
        assert.deepEqual(requests[0].body.tools, definitions);
        assert.deepEqual(JSON.parse(requests[1].body.messages.at(-1).content), { ok: true, result: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
      } finally { await bot.close(); }
    }, [toolReply, {}]);
  }
});

test('tool argument validation remains without an execution allowlist', () => {
  assert.equal(executeTool('sha256', '{"text":"abc"}', []).ok, true);
  assert.equal(executeTool('sha256', '{"text":"abc"}', ['current_time']).ok, true);
  for (const raw of ['null', '[]', '{', '{"text":1}', '{"text":"x","file":"secret"}']) assert.equal(executeTool('sha256', raw, []).ok, false);
  assert.equal(executeTool('shell', '{}', ['shell']).ok, false);
  assert.match(executeTool('current_time', '{}', []).text, /^\d{4}-/);
});

test('HTTP failure rolls back incomplete turn and redacts provider body', async () => {
  await fixture(async (url, requests) => {
    const bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url }));
    await assert.rejects(bot.send('failed'), { message: 'Model HTTP status 401' });
    assert.equal(await bot.send('retry'), 'ok');
    assert.equal(requests[1].body.messages.length, 2);
    assert.equal(requests[1].body.messages[1].content, 'retry');
  }, [{ status: 401, raw: 'sensitive provider diagnostics' }, {}]);
});

test('redirects are followed while preserving the POST body', async () => {
  await fixture(async (url, requests) => {
    const bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url }));
    try {
      assert.equal(await bot.send('test'), 'ok');
      assert.equal(requests.length, 2);
      assert.equal(requests[1].url, '/v1/redirected');
      assert.deepEqual(requests[1].body, requests[0].body);
    } finally { await bot.close(); }
  }, [{ status: 307, headers: { Location: '/v1/redirected' } }, {}]);
});

test('invalid JSON, truncated replies and invalid protocol types still fail closed', async () => {
  for (const reply of [
    { raw: '{' },
    { finish_reason: 'length' },
    { message: { role: 'user', content: 'bad' } },
    { raw: '{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":42}}]}' },
    { raw: '{"choices":[{"finish_reason":42,"message":{"role":"assistant","content":"bad"}}]}' },
    { raw: '{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":"bad"}}]}' },
  ]) {
    await fixture(async url => {
      const bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url }));
      try { await assert.rejects(bot.send('test')); }
      finally { await bot.close(); }
    }, [reply]);
  }
});

test('user input and valid model replies may exceed former size limits', async () => {
  const input = 'x'.repeat(32001);
  const output = 'y'.repeat(2_000_001);
  await fixture(async (url, requests) => {
    const bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url }));
    try {
      for (const text of ['', '  ', null, 42, {}]) await assert.rejects(bot.send(text as string), /Message/);
      assert.equal(await bot.send(input), output);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].body.messages.at(-1).content, input);
    } finally { await bot.close(); }
  }, [{ message: { role: 'assistant', content: output } }]);
});

test('tool rounds exceed both the old default and explicit maxRounds configuration', async () => {
  await fixture(async (url, requests) => {
    const bot = new Conversation({ ...loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_MAX_ROUNDS: '1' }), maxRounds: 1 });
    try {
      assert.equal(await bot.send('keep hashing'), 'ok');
      assert.equal(requests.length, 41);
      assert.equal(requests[40].body.messages.filter(message => message.tool_call_id === 'call_1').length, 40);
      assert.equal(await bot.send('continue'), 'ok');
    } finally { await bot.close(); }
  }, [...Array.from({ length: 40 }, () => toolReply), {}, {}]);
});

test('legacy timeoutMs does not abort a slow HTTP response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await fixture(async url => {
    const bot = new Conversation({ ...loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_TIMEOUT_MS: '1' }), timeoutMs: 1 });
    try { assert.equal(await bot.send('wait for the response'), 'ok'); }
    finally { await bot.close(); }
  }, [{ beforeReply: () => t.mock.timers.tick(10) }]);
});

test('upstream protocol parser rejects duplicate IDs and truncated calls', () => {
  const parser = new ChatToolCalls();
  parser.add([...toolReply.message.tool_calls, ...toolReply.message.tool_calls], false);
  assert.throws(() => parser.finish('tool_calls', false), /duplicate/);
  const incomplete = new ChatToolCalls();
  incomplete.add(toolReply.message.tool_calls, false);
  assert.throws(() => incomplete.finish('length', false), /truncated/);
});


test('CLI help and missing configuration do not require credentials or a live service', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const help = spawnSync(process.execPath, ['src/cli.ts', '--help'], { encoding: 'utf8', env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /HEZUO_CORE_MODEL/);
  const invalid = spawnSync(process.execPath, ['src/cli.ts', '--message', 'hello'], { encoding: 'utf8', env });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /HEZUO_CORE_MODEL/);
});

test('model invokes browser tools regardless of config.tools; lifecycle closes terminally', async t => {
  const stub = t.mock.method(BrowserSession.prototype, 'execute', async () => ({ ok: true, text: 'mock page' }));
  await fixture(async (url, requests) => {
    const bot = new Conversation({ ...loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url }), tools: [] });
    try {
      assert.equal(await bot.send('browse with the mock'), 'ok');
      const reply = requests[1].body.messages.find(message => message.tool_call_id === 'web_call');
      assert(reply && typeof reply.content === 'string');
      assert.deepEqual(JSON.parse(reply.content), { ok: true, result: 'mock page' });
      assert.deepEqual(requests[0].body.tools, orderScenarioTools(definitions, 'web'));
      assert.equal(stub.mock.callCount(), 1);
      assert.deepEqual(stub.mock.calls[0].arguments.slice(0, 2), ['browser_open', '{"url":"https://example.com/"}']);
      assert(stub.mock.calls[0].arguments[2] instanceof AbortSignal);
    } finally { await bot.close(); }
    await assert.rejects(bot.send('again'), /closed/);
  }, [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
    { id: 'web_call', type: 'function', function: { name: 'browser_open', arguments: '{"url":"https://example.com/"}' } },
  ] } }, {}]);
});

test('Conversation permits repeated tools after three failures and beyond 15 calls', async t => {
  let attempts = 0;
  const stub = t.mock.method(ComputerSession.prototype, 'execute', async () => {
    attempts++;
    return attempts <= 3 ? { ok: false, text: 'mock refusal' } : { ok: true, text: 'mock dispatched' };
  });
  const reply = { finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
    { id: 'repeat', type: 'function', function: { name: 'computer_press_key', arguments: '{"key":"tab"}' } },
  ] } };
  await fixture(async (url, requests) => {
    const bot = new Conversation({ ...loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_BROWSER_BACKEND: 'computer_use', HEZUO_CORE_TOOLS: 'computer_window', HEZUO_CORE_MAX_ROUNDS: '1' }), tools: [], maxRounds: 1 });
    try {
      assert.equal(await bot.send('repeat safe mock actions'), 'ok');
      assert.equal(stub.mock.callCount(), 20);
      const results = requests[20].body.messages.filter(message => message.tool_call_id === 'repeat');
      assert.equal(results.length, 20);
      for (const [index, result] of results.entries()) {
        assert.deepEqual(JSON.parse(result.content), index < 3
          ? { ok: false, result: 'mock refusal' }
          : { ok: true, result: 'mock dispatched' });
      }
      assert.equal(await bot.send('continue next instruction'), 'ok');
    } finally { await bot.close(); }
  }, [...Array.from({ length: 20 }, () => reply), {}, {}]);
});

test('Conversation retains every screenshot across tool rounds and subsequent turns', async t => {
  let captures = 0;
  t.mock.method(ComputerSession.prototype, 'execute', async () => ({ ok: true, text: 'capture', image: pngCapture(++captures), mime: 'image/png' as const }));
  const reply = { finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
    { id: 'capture', type: 'function', function: { name: 'computer_window', arguments: '{}' } },
  ] } };
  await fixture(async (url, requests) => {
    const bot = new Conversation({ ...loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_BROWSER_BACKEND: 'computer_use' }), tools: [] });
    try {
      assert.equal(await bot.send('capture five times'), 'ok');
      assert.equal(await bot.send('retain all captures'), 'ok');
      assert.equal(captures, 5);
      for (const index of [5, 6]) {
        const history = JSON.stringify(requests[index].body.messages);
        assert.equal((history.match(/data:image\/png;base64,/g) || []).length, 5);
        for (let capture = 1; capture <= 5; capture++) {
          assert(history.includes(`data:image/png;base64,${pngCapture(capture)}`));
        }
      }
    } finally { await bot.close(); }
  }, [...Array.from({ length: 5 }, () => reply), {}, {}]);
});

test('screenshot validator accepts canonical PNG/JPEG and enforces magic, MIME, base64 and 8 MiB', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
  assert.deepEqual(validateScreenshot({ image: PNG, mime: 'image/png' }), { image: PNG, mime: 'image/png' });
  assert.deepEqual(validateScreenshot({ image: jpeg, mime: 'image/jpeg' }), { image: jpeg, mime: 'image/jpeg' });
  for (const input of [null, undefined, '', {}, { image: PNG },
    { image: PNG, mime: 'image/jpeg' }, { image: jpeg, mime: 'image/png' },
    { image: PNG, mime: 'image/gif' }, { image: 123, mime: 'image/png' },
    ...['', 'YWJj', PNG.slice(0, -1), `${PNG}\n`, `data:image/png;base64,${PNG}`,
      PNG.replace(/=$/, '=='), PNG.replace(/I=$/, 'J='), '!!!!', '/9g=']
      .map(image => ({ image, mime: 'image/png' })),
  ]) assert.equal(validateScreenshot(input), undefined);
  const bytes = Buffer.alloc(8 * 1024 * 1024);
  Buffer.from(PNG, 'base64').copy(bytes);
  const image = bytes.toString('base64');
  assert.deepEqual(validateScreenshot({ image, mime: 'image/png' }), { image, mime: 'image/png' });
  assert.equal(validateScreenshot({ image: Buffer.concat([bytes, Buffer.alloc(1)]).toString('base64'), mime: 'image/png' }), undefined);
});

test('text claims and invalid tool images never manufacture screenshots', async t => {
  const screenshots: Screenshot[] = [];
  t.mock.method(BrowserSession.prototype, 'execute', async () => ({ ok: true, text: '二维码已展示', image: 'YWJj', mime: 'image/png' as const }));
  await fixture(async (url, requests) => {
    const bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url }), undefined, s => screenshots.push(s));
    try {
      assert.equal(await bot.send('展示淘股吧登录二维码'), '二维码已展示');
      assert.deepEqual(screenshots, []);
      assert(!JSON.stringify(requests[1].body.messages).includes('data:image/'));
      const prompt = requests[0].body.messages[0].content;
      for (const instruction of ['已核实的登录入口', '真实截图', '不能仅用文字', '不要自动扫描或批准二维码', '完成登录或交易', '不调用本地密码登录', 'browser_dialogs', 'browser_dialog_accept', 'browser_dialog_dismiss', 'Do not treat a pending action as completed']) assert(prompt.includes(instruction));
      for (const instruction of ['action-plus-observation', 'do not immediately repeat', 'never replay a write action', 'stop scheduling actions or observations when cancelled']) assert(prompt.includes(instruction));
    } finally { await bot.close(); }
  }, [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
    { id: 'capture', type: 'function', function: { name: 'browser_screenshot', arguments: '{}' } },
  ] } }, { message: { role: 'assistant', content: '二维码已展示' } }]);
});

for (const backend of ['legacy', 'computer_use'] as const) {
  test(`completed screenshot is delivered and retained after cancellation (${backend})`, async t => {
    let bot: Conversation;
    const screenshots: Screenshot[] = [];
    let executed = 0;
    t.mock.method(backend === 'legacy' ? BrowserSession.prototype : ComputerSession.prototype, 'execute', async () => {
      executed++;
      bot.cancel(); // Cancellation while the tool is completing must not discard its capture.
      return { ok: true, text: 'capture', image: PNG, mime: 'image/png' as const };
    });
    await fixture(async (url, requests) => {
      bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url,
        ...(backend === 'computer_use' ? { HEZUO_CORE_BROWSER_BACKEND: backend } : {}) }), undefined, s => {
        screenshots.push(s);
        throw new Error('consumer failure'); // Callback errors must not break protocol completion.
      });
      try {
        await assert.rejects(bot.send('capture and stop'));
        assert.deepEqual(screenshots, [{ image: PNG, mime: 'image/png' }]);
        assert.equal(executed, 1);
        assert.equal(await bot.send('continue'), 'ok');
        const replay = requests[1].body.messages;
        const replies = replay.filter(m => m.tool_call_id);
        assert.deepEqual(replies.map(m => m.tool_call_id), ['first', 'second']);
        assert.equal(JSON.parse(replies[1].content).code, 'CANCELLED');
        assert(!JSON.stringify(replies).includes(PNG));
        assert(JSON.stringify(replay).includes(`data:image/png;base64,${PNG}`));
        assert(!JSON.stringify(bot.computerAudit() ?? {}).includes(PNG));
      } finally { await bot.close(); }
    }, [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: ['first', 'second'].map(id => ({
      id, type: 'function', function: { name: backend === 'legacy' ? 'browser_screenshot' : 'computer_window', arguments: '{}' },
    })) } }, {}]);
  });
}

for (const ok of [true, false]) {
  test(`legacy JPEG without MIME is delivered only for successful results (ok=${ok})`, async t => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
    const screenshots: Screenshot[] = [];
    // BrowserResult intentionally has no MIME field; its screenshots are JPEG.
    t.mock.method(BrowserSession.prototype, 'execute', async () => ({ ok, text: 'capture', image }));
    await fixture(async (url, requests) => {
      const bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url }), undefined, s => screenshots.push(s));
      try {
        assert.equal(await bot.send('capture'), 'ok');
        assert.deepEqual(screenshots, ok ? [{ image, mime: 'image/jpeg' }] : []);
        assert.equal(JSON.stringify(requests[1].body.messages).includes(`data:image/jpeg;base64,${image}`), ok);
        const replies = requests[1].body.messages.filter(m => m.tool_call_id);
        assert.equal(replies.length, 1);
        assert(!('image' in JSON.parse(replies[0].content)));
      } finally { await bot.close(); }
    }, [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'capture', type: 'function', function: { name: 'browser_screenshot', arguments: '{}' } },
    ] } }, {}]);
  });
}

for (const outcome of ['ok', 'error', 'cancelled'] as const) {
  test(`all-backend timing audit records request/tool/run without payload (${outcome})`, async t => {
    let bot: Conversation;
    t.mock.method(BrowserSession.prototype, 'execute', async (_name, _raw, signal?: AbortSignal) => {
      assert(signal instanceof AbortSignal);
      if (outcome === 'cancelled') bot.cancel();
      return { ok: outcome === 'ok', text: 'private tool result', image: PNG, mime: 'image/png' };
    });
    await fixture(async url => {
      bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_API_KEY: 'private-key' }));
      try {
        if (outcome === 'cancelled') await assert.rejects(bot.send('private request body'));
        else assert.equal(await bot.send('private request body'), 'ok');
        const audit = bot.timingAudit();
        assert.equal(audit.runs.length, 1);
        assert.equal(audit.runs[0].rounds, outcome === 'cancelled' ? 1 : 2);
        assert.equal(audit.runs[0].outcome, outcome === 'cancelled' ? 'cancelled' : 'ok');
        assert.equal(audit.requests.length, audit.runs[0].rounds);
        assert.equal(audit.tools.length, 1);
        assert.equal(audit.tools[0].outcome, outcome);
        assert.equal(audit.tools[0].name, 'browser_click');
        assert.equal(audit.tools[0].round, 1);
        for (const entry of [...audit.requests, ...audit.tools, ...audit.runs]) {
          assert(Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0);
          assert.equal(entry.run, 1);
        }
        for (const secret of ['private-key', 'private request body', 'private tool result', PNG, 'secret-selector']) {
          assert(!JSON.stringify(audit).includes(secret));
        }
        audit.runs[0].rounds = 999;
        assert.notEqual(bot.timingAudit().runs[0].rounds, 999);
      } finally { await bot.close(); }
    }, [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'observe', type: 'function', function: { name: 'browser_click', arguments: '{"id":"secret-selector","observe":"read"}' } },
    ] } }, {}]);
  });
}

test('model transport errors still finalize request and run timings', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private transport detail'); });
  const bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture' }));
  try {
    await assert.rejects(bot.send('private body'), /Model transport failed/);
    const audit = bot.timingAudit();
    assert.equal(audit.requests.length, 1);
    assert.equal(audit.requests[0].status, 0);
    assert.equal(audit.runs[0].outcome, 'error');
    assert.equal(audit.runs[0].rounds, 1);
    assert.equal(audit.tools.length, 0);
    assert(!JSON.stringify(audit).includes('private'));
  } finally { await bot.close(); }
});

test('combined CUA action delivers screenshot through existing callback, not tool history or audit', async t => {
  const screenshots: Screenshot[] = [];
  t.mock.method(ComputerSession.prototype, 'execute', async (name, raw, signal?: AbortSignal) => {
    assert.equal(name, 'computer_action_and_screenshot');
    assert.equal(JSON.parse(raw).action.name, 'computer_click');
    assert(signal instanceof AbortSignal);
    return { ok: true, text: 'Action completed; screenshot captured', image: PNG, mime: 'image/png', detail: { actionOk: true, observationAttempted: true, observationOk: true } };
  });
  await fixture(async (url, requests) => {
    const bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_BROWSER_BACKEND: 'computer_use' }), undefined, s => screenshots.push(s));
    try {
      assert.equal(await bot.send('click then observe'), 'ok');
      assert.deepEqual(screenshots, [{ image: PNG, mime: 'image/png' }]);
      const reply = requests[1].body.messages.find(m => m.tool_call_id === 'combined');
      assert(reply);
      assert(!reply.content.includes(PNG));
      assert.equal(JSON.parse(reply.content).detail.observationOk, true);
      assert(JSON.stringify(requests[1].body.messages).includes(`data:image/png;base64,${PNG}`));
      assert(!JSON.stringify(bot.computerAudit()).includes(PNG));
      assert.equal(bot.timingAudit().tools.length, 1);
      assert.equal(bot.timingAudit().runs[0].rounds, 2);
    } finally { await bot.close(); }
  }, [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
    { id: 'combined', type: 'function', function: { name: 'computer_action_and_screenshot', arguments: '{"action":{"name":"computer_click","arguments":{"x":1,"y":2}}}' } },
  ] } }, {}]);
});

test('timing audit measures controlled request duration including body parsing', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    now += 7;
    return { ok: true, status: 200, body: new ReadableStream({ start(controller) {
      now += 11;
      controller.enqueue(Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] })));
      controller.close();
    } }) } as Response;
  });
  const bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture' }));
  try {
    assert.equal(await bot.send('hello'), 'ok');
    assert.equal(bot.timingAudit().requests[0].elapsedMs, 18);
    assert.equal(bot.timingAudit().runs[0].elapsedMs, 18);
  } finally { await bot.close(); }
});

for (const phase of ['headers', 'body'] as const) {
  test(`model cancellation remains AbortError during ${phase}`, async t => {
    let bot: Conversation;
    t.mock.method(globalThis, 'fetch', async () => {
      if (phase === 'headers') { bot.cancel(); throw new Error('transport detail'); }
      return { ok: true, status: 200, body: new ReadableStream({ pull() {
        bot.cancel();
        throw new Error('body detail');
      } }) } as Response;
    });
    bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture' }));
    try {
      await assert.rejects(bot.send('cancel'), { name: 'AbortError' });
      assert.equal(bot.timingAudit().runs[0].outcome, 'cancelled');
      assert.equal(bot.timingAudit().requests.length, 1);
      assert.equal(bot.timingAudit().tools.length, 0);
    } finally { await bot.close(); }
  });
}

test('concurrent and repeated close share one cleanup task including failure', async t => {
  const closed = Promise.withResolvers<void>();
  const failure = new Error('cleanup failed');
  const stub = t.mock.method(BrowserSession.prototype, 'close', () => closed.promise);
  const bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture' }));
  const first = bot.close();
  const second = bot.close();
  assert.equal(first, second);
  const rejection = assert.rejects(first, error => error === failure);
  closed.reject(failure);
  await rejection;
  assert.equal(bot.close(), first);
  assert.equal(stub.mock.callCount(), 1);
});

for (const cancelled of [false, true]) {
  test(`AX combination participates in shared timing audit (cancelled=${cancelled})`, async t => {
    let bot: Conversation;
    t.mock.method(AxSession.prototype, 'execute', async (_name, _raw, signal?: AbortSignal) => {
      assert(signal instanceof AbortSignal);
      if (cancelled) bot.cancel();
      return { ok: true, text: 'fresh same-app snapshot' };
    });
    await fixture(async url => {
      bot = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: url, HEZUO_CORE_BROWSER_BACKEND: 'computer_use', HEZUO_CORE_DESKTOP_BACKEND: 'ax' }));
      try {
        if (cancelled) await assert.rejects(bot.send('click and inspect'));
        else assert.equal(await bot.send('click and inspect'), 'ok');
        const audit = bot.computerAudit();
        assert(audit);
        assert.equal(audit.tools[0].name, 'desktop_click_and_snapshot');
        assert.equal(audit.tools[0].outcome, cancelled ? 'cancelled' : 'ok');
        assert.equal(audit.runs[0].rounds, cancelled ? 1 : 2);
      } finally { await bot.close(); }
    }, [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'ax-combined', type: 'function', function: { name: 'desktop_click_and_snapshot', arguments: '{"ref_id":"app:1","app":"MockApp"}' } },
    ] } }, {}]);
  });
}
