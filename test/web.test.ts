import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { createWebServer, type ChatSession, type ScreenshotSink } from '../src/web-server.ts';
import { Conversation } from '../src/core.ts';
import { loadConfig } from '../src/config.ts';
import { definitions } from '../src/tools.ts';
import { BrowserSession } from '../src/browser.ts';

const config = loadConfig({
  HEZUO_CORE_MODEL: 'web-fixture',
  HEZUO_CORE_BASE_URL: 'https://model.invalid/v1',
  HEZUO_CORE_API_KEY: 'fixture-secret-never-public',
  HEZUO_CORE_TOOLS: '',
});

type State = {
  token: string;
  messages: Array<{ role: string; text: string; attachments?: Array<{ id: string; mimeType: string; url: string; name: string }> }>;
  busy: boolean;
  closing: boolean;
  closed: boolean;
  error: string;
};
type Reply = { status: number; headers: IncomingHttpHeaders; text: string };
type Options = { method?: string; headers?: Record<string, string | undefined>; raw?: string; chunked?: boolean };

const deferred = <T>() => Promise.withResolvers<T>();

async function withWeb(factory: (onScreenshot: ScreenshotSink) => ChatSession, run: (web: {
  origin: string;
  call: (path: string, options?: Options) => Promise<Reply>;
  state: () => Promise<State>;
  post: (path: string, body?: unknown, options?: Options) => Promise<Reply>;
  shutdown: () => Promise<void>;
}) => Promise<void>, settings = config) {
  const app = createWebServer(settings, factory, 0);
  try {
    const listening = Promise.withResolvers<void>();
    app.server.once('error', listening.reject);
    app.server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const address = app.server.address();
    assert(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const call = (path: string, options: Options = {}) => {
      const { promise, resolve, reject } = Promise.withResolvers<Reply>();
      const raw = options.raw;
      const headers: Record<string, string> = { host: `127.0.0.1:${address.port}`, connection: 'close' };
      if (raw !== undefined && !options.chunked) headers['content-length'] = String(Buffer.byteLength(raw));
      if (options.chunked) headers['transfer-encoding'] = 'chunked';
      for (const [key, value] of Object.entries(options.headers || {})) {
        if (value === undefined) delete headers[key];
        else headers[key] = value;
      }
      const req = request({ hostname: '127.0.0.1', port: address.port, path, method: options.method || 'GET', headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Loopback fixture request timed out')));
      req.end(raw);
      return promise;
    };
    const state = async () => {
      const reply = await call('/api/state');
      assert.equal(reply.status, 200);
      return JSON.parse(reply.text) as State;
    };
    const token = (await state()).token;
    const post = (path: string, body: unknown = {}, options: Options = {}) => call(path, {
      ...options,
      method: options.method || 'POST',
      raw: options.raw ?? JSON.stringify(body),
      headers: { origin, 'x-session-token': token, 'content-type': 'application/json', ...options.headers },
    });
    await run({ origin, call, state, post, shutdown: app.shutdown });
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

test('web: Computer Use pause requires auth, idle session and keeps browser open', async () => {
  let pauses = 0; let closes = 0;
  await withWeb(() => ({ send: async () => 'ready', cancel() {}, close: async () => { closes++; }, pauseComputer: () => { pauses++; } }), async ({ post, state }) => {
    assert.equal((await post('/api/pause')).status, 409);
    assert.equal((await post('/api/send', { text: 'Open login page' })).status, 202);
    for (let attempt = 0; (await state()).busy; attempt++) assert(attempt < 200, 'fixture send did not settle');
    assert.equal((await post('/api/pause', {}, { headers: { 'x-session-token': '0'.repeat(64) } })).status, 403);
    assert.equal((await post('/api/pause', { text: 'unexpected' })).status, 400);
    assert.equal((await post('/api/pause')).status, 200);
    assert.equal(pauses, 1); assert.equal(closes, 0);
    assert((await state()).messages.some(m => m.text.includes('Computer Use 已暂停')));
  }, { ...config, browserBackend: 'computer_use' });
  assert.equal(closes, 1);
});

async function until(state: () => Promise<State>, predicate: (value: State) => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await state();
    if (predicate(value)) return value;
  }
  assert.fail('Web state did not settle');
}

function inert(): ChatSession {
  return { async send(text) { return `reply:${text}`; }, cancel() {}, async close() {} };
}

function noSecrets(reply: Reply | State) {
  const text = JSON.stringify(reply);
  for (const secret of ['fixture-secret-never-public', 'private-page-password', '/private/secret.env']) {
    assert.equal(text.includes(secret), false, `Leaked ${secret}`);
  }
}

test('web: loopback Host, Origin, fetch metadata, token and JSON gates precede session creation', { timeout: 15000 }, async () => {
  let created = 0;
  await withWeb(() => { created++; return inert(); }, async ({ origin, call, post, state }) => {
    const initial = await state();
    assert.match(initial.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(initial.messages, []);
    assert.equal(initial.busy, false);
    assert.equal(initial.closed, false);
    for (const host of ['evil.example', 'localhost:1234', '127.0.0.1:1']) {
      assert.equal((await call('/api/state', { headers: { host } })).status, 403);
    }
    assert.equal((await call('/api/state', { headers: { origin: 'https://evil.example' } })).status, 403);
    for (const site of ['cross-site', 'same-site', 'invalid']) {
      assert.equal((await call('/api/state', { headers: { 'sec-fetch-site': site } })).status, 403);
      assert.equal((await post('/api/send', { text: 'blocked' }, { headers: { 'sec-fetch-site': site } })).status, 403);
    }
    for (const site of ['same-origin', 'none']) {
      assert.equal((await call('/api/state', { headers: { origin, 'sec-fetch-site': site } })).status, 200);
    }
    for (const path of ['/api/send', '/api/reset', '/api/cancel']) {
      for (const badOrigin of [undefined, 'null', 'http://evil.example', `${origin}/`]) {
        assert.equal((await post(path, {}, { headers: { origin: badOrigin } })).status, 403);
      }
      for (const token of [undefined, '', 'wrong', 'g'.repeat(64), '0'.repeat(64), 'a'.repeat(63)]) {
        assert.equal((await post(path, {}, { headers: { 'x-session-token': token } })).status, 403);
      }
      assert.equal((await call(path)).status, 405);
      assert.equal((await post(path, {}, { headers: { 'content-type': undefined } })).status, 415);
      assert.equal((await post(path, {}, { headers: { 'content-type': 'text/plain' } })).status, 415);
      assert.equal((await post(path, {}, { headers: { 'content-encoding': 'gzip' } })).status, 415);
      for (const raw of ['', '{', 'undefined', 'null', '[]', '1', '"text"']) {
        assert.equal((await post(path, {}, { raw })).status, 400, `${path}: ${raw}`);
      }
    }
    assert.equal(created, 0);
    assert.deepEqual((await state()).messages, []);
  });
});

test('web: only explicit public assets are served, never traversal, dotfiles or source', async () => {
  await withWeb(() => { assert.fail('GET must not create a session'); }, async ({ call }) => {
    for (const [path, mime] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
      const reply = await call(path!);
      assert.equal(reply.status, 200, path);
      assert.ok(reply.headers['content-type']?.startsWith(mime!));
      assert.equal(reply.headers['cache-control'], 'no-store');
      assert.equal(reply.headers['x-content-type-options'], 'nosniff');
      assert.equal(reply.headers['referrer-policy'], 'no-referrer');
      assert.equal(reply.headers['cross-origin-resource-policy'], 'same-origin');
      assert.match(String(reply.headers['content-security-policy']), /default-src 'none'/);
      assert.match(String(reply.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.equal(reply.headers['access-control-allow-origin'], undefined);
    }
    for (const path of ['/.env', '/.env.example', '/src/core.ts', '/src/web-server.ts', '/package.json', '/../.env', '/web/../../.env', '/%2e%2e/.env', '/%2e%2e%2fsrc/core.ts', '/..\\.env', '/style.css/../.env', '/constructor', '/toString']) {
      const reply = await call(path);
      assert.equal(reply.status, 404, path);
      assert.deepEqual(JSON.parse(reply.text), { error: 'Not found' });
      noSecrets(reply);
    }
  });
});

test('web: history can grow beyond the former 400-message quota', async () => {
  await withWeb(inert, async ({ post, state }) => {
    for (let i = 0; i < 205; i++) {
      assert.equal((await post('/api/send', { text: `turn ${i}` })).status, 202);
      await until(state, s => !s.busy);
    }
    assert.equal((await state()).messages.length, 410);
  });
});

test('web: message schema remains strict while message and body sizes are unrestricted', async () => {
  let created = 0;
  await withWeb(() => { created++; return inert(); }, async ({ post, state }) => {
    for (const body of [{}, { text: '' }, { text: ' \n\t' }, { text: 3 }, { text: null }, { text: [] }, { text: 'x', extra: true }]) {
      assert.equal((await post('/api/send', body)).status, 400);
    }
    for (const path of ['/api/cancel', '/api/reset']) {
      assert.equal((await post(path, { text: 'not allowed' })).status, 400);
    }
    assert.equal(created, 0);
    assert.deepEqual((await state()).messages, []);
    for (const chunked of [false, true]) {
      for (const text of ['x'.repeat(32001), 'x'.repeat(140001), '😀'.repeat(36000)]) {
        assert.equal((await post('/api/send', { text }, { chunked })).status, 202);
        const current = await until(state, s => !s.busy);
        assert.equal(current.messages.at(-2)?.text, text);
      }
    }
    assert.equal(created, 1);
  });
});

test('web: lazy creation reuses one session for turns; reset closes, clears and defers replacement', async () => {
  const sessions: Array<{ sent: string[]; closes: number }> = [];
  await withWeb(() => {
    const record = { sent: [] as string[], closes: 0 };
    sessions.push(record);
    return { async send(text) { record.sent.push(text); return `answer:${text}`; }, cancel() {}, async close() { record.closes++; } };
  }, async ({ state, post }) => {
    assert.equal(sessions.length, 0);
    assert.equal((await post('/api/reset')).status, 200);
    assert.equal(sessions.length, 0);
    for (const text of ['first', 'second']) {
      assert.equal((await post('/api/send', { text })).status, 202);
      await until(state, s => !s.busy);
    }
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0]!.sent, ['first', 'second']);
    assert.deepEqual((await state()).messages, [
      { role: 'user', text: 'first' }, { role: 'assistant', text: 'answer:first' },
      { role: 'user', text: 'second' }, { role: 'assistant', text: 'answer:second' },
    ]);
    const token = (await state()).token;
    assert.equal((await post('/api/reset')).status, 200);
    assert.equal(sessions[0]!.closes, 1);
    assert.equal(sessions.length, 1);
    const fresh = await state();
    assert.deepEqual(fresh.messages, []);
    assert.equal(fresh.error, '');
    assert.equal(fresh.closed, false);
    assert.equal(fresh.token, token);
    assert.equal((await post('/api/send', { text: 'new' })).status, 202);
    await until(state, s => !s.busy);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[1]!.sent, ['new']);
  });
  assert.equal(sessions[1]!.closes, 1);
});

for (const operation of ['cancel', 'reset'] as const) {
  test(`web: concurrent sends get 409; ${operation} waits for settlement and suppresses stale replies`, async () => {
    const turn = deferred<string>();
    const closing = deferred<void>();
    let created = 0;
    let closes = 0;
    let cancels = 0;
    await withWeb(() => {
      created++;
      return { send: () => turn.promise, cancel() { cancels++; }, async close() { closes++; await closing.promise; } };
    }, async ({ post, state }) => {
      let retirement: Promise<Reply> | undefined;
      try {
        assert.equal((await post('/api/send', { text: 'pending' })).status, 202);
        assert.equal((await state()).busy, true);
        const conflicts = await Promise.all([post('/api/send', { text: 'racer one' }), post('/api/send', { text: 'racer two' })]);
        assert.deepEqual(conflicts.map(r => r.status), [409, 409]);
        retirement = post(`/api/${operation}`);
        await until(state, s => s.closing);
        assert.equal(closes, operation === 'reset' ? 1 : 0);
        assert.equal(cancels, operation === 'cancel' ? 1 : 0);
        assert.equal((await post('/api/send', { text: 'during close' })).status, 409);
        assert.equal((await post('/api/reset')).status, 409);
        assert.equal(created, 1);
        turn.resolve('stale-secret-reply');
        await until(state, s => !s.busy);
        if (operation === 'reset') assert.equal((await state()).closing, true);
        closing.resolve();
        assert.equal((await retirement).status, 200);
        const final = await state();
        assert.equal(final.closed, false);
        assert.equal(final.closing, false);
        assert.equal(final.error, '');
        assert.equal(JSON.stringify(final.messages).includes('stale-secret-reply'), false);
        if (operation === 'reset') assert.deepEqual(final.messages, []);
        else {
          assert.deepEqual(final.messages[0], { role: 'user', text: 'pending' });
          assert.match(final.messages[1]!.text, /历史已保留/);
          assert.equal((await post('/api/send', { text: 'after cancel' })).status, 202);
          await until(state, s => !s.busy);
        }
        assert.equal(created, 1);
      } finally {
        turn.resolve('cleanup');
        closing.resolve();
        await retirement;
      }
    });
  });
}

const privateError = () => new Error('fixture-secret-never-public private-page-password /private/secret.env');

test('web: factory, send and close errors are sanitised, reset clears error state', async () => {
  let mode: 'factory' | 'send' | 'close' = 'factory';
  await withWeb(() => {
    if (mode === 'factory') throw privateError();
    return { async send() { throw privateError(); }, cancel() {}, async close() { if (mode === 'close') throw privateError(); } };
  }, async ({ post, state }) => {
    const factoryFailure = await post('/api/send', { text: 'factory failure' });
    assert.equal(factoryFailure.status, 500);
    noSecrets(factoryFailure);
    assert.deepEqual((await state()).messages, []);
    mode = 'send';
    assert.equal((await post('/api/send', { text: 'send failure' })).status, 202);
    const failed = await until(state, s => !s.busy);
    assert.ok(failed.error);
    assert.equal(failed.messages.at(-1)?.role, 'error');
    assert.equal(failed.messages.at(-1)?.text, failed.error);
    noSecrets(failed);
    assert.equal((await post('/api/reset')).status, 200);
    assert.deepEqual((await state()).messages, []);
    assert.equal((await state()).error, '');
    assert.equal((await post('/api/send', { text: 'close failure' })).status, 202);
    await until(state, s => !s.busy);
    mode = 'close';
    try {
      const closeFailure = await post('/api/reset');
      assert.equal(closeFailure.status, 500);
      noSecrets(closeFailure);
      const closed = await state();
      assert.equal(closed.closed, true);
      assert.ok(closed.error);
      noSecrets(closed);
      assert.equal((await post('/api/send', { text: 'blocked' })).status, 409);
    } finally { mode = 'send'; }
  });
});

test('web: real Conversation retains history and cancel aborts only the current fetch', { timeout: 15000 }, async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ model: string; stream: boolean; tools?: unknown; messages: Array<{ role: string; content: string }> }> = [];
  const instances: Conversation[] = [];
  const started = deferred<void>();
  let aborted = false;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://model.invalid/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'follow');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-secret-never-public');
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    assert.equal(body.model, 'web-fixture');
    assert.equal(body.stream, false);
    assert.deepEqual(body.tools, definitions);
    if (requests.length === 3) {
      assert.ok(init?.signal);
      const signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        started.resolve();
      });
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `real-answer-${requests.length}` } }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    assert.deepEqual([...config.tools].sort(), definitions.map(tool => tool.function.name).sort());
    await withWeb(() => {
      const conversation = new Conversation(config);
      instances.push(conversation);
      return conversation;
    }, async ({ post, state }) => {
      assert.equal(instances.length, 0);
      for (const text of ['hello', 'follow up']) {
        assert.equal((await post('/api/send', { text })).status, 202);
        await until(state, s => !s.busy);
      }
      assert.equal(instances.length, 1);
      assert.deepEqual(requests[0]!.messages.slice(1), [{ role: 'user', content: 'hello' }]);
      assert.deepEqual(requests[1]!.messages.slice(1), [
        { role: 'user', content: 'hello' }, { role: 'assistant', content: 'real-answer-1' }, { role: 'user', content: 'follow up' },
      ]);
      assert.deepEqual((await state()).messages.map(m => m.text), ['hello', 'real-answer-1', 'follow up', 'real-answer-2']);
      assert.equal((await post('/api/send', { text: 'abort this request' })).status, 202);
      await started.promise;
      assert.equal((await post('/api/cancel')).status, 200);
      assert.equal(aborted, true);
      const cancelled = await state();
      assert.equal(cancelled.busy, false);
      assert.equal(cancelled.closed, false);
      assert.equal(cancelled.error, '');
      assert.equal(cancelled.messages.length, 6);
      assert.match(cancelled.messages.at(-1)!.text, /历史已保留/);
      noSecrets(cancelled);
      assert.equal((await post('/api/send', { text: 'continue without reset' })).status, 202);
      await until(state, s => !s.busy);
      assert.equal(instances.length, 1);
      assert.equal(requests.length, 4);
      assert.deepEqual(requests[3]!.messages.slice(1).map(m => m.content), [
        'hello', 'real-answer-1', 'follow up', 'real-answer-2', 'abort this request', 'continue without reset',
      ]);
      assert.equal((await post('/api/reset')).status, 200);
      assert.deepEqual((await state()).messages, []);
      assert.equal(instances.length, 1);
      assert.equal((await post('/api/send', { text: 'fresh context' })).status, 202);
      await until(state, s => !s.busy);
      assert.equal(instances.length, 2);
      assert.deepEqual(requests[4]!.messages.slice(1), [{ role: 'user', content: 'fresh context' }]);
    });
  } finally {
    try { await Promise.all(instances.map(instance => instance.close())); }
    finally { globalThis.fetch = originalFetch; }
  }
});

const screenshotPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==';

test('web: real screenshot bytes travel separately from state and survive cancellation until reset', async () => {
  let emit: ScreenshotSink;
  let finish = deferred<string>();
  await withWeb(sink => {
    emit = sink;
    return {
      async send() { sink({ image: screenshotPng, mime: 'image/png' }); return finish.promise; },
      cancel() {
        // An already-started screenshot can settle while Stop is waiting.
        sink({ image: screenshotPng, mime: 'image/png' });
        finish.resolve('late answer must not be appended');
      },
      close: async () => { finish.resolve('closed'); },
    };
  }, async ({ post, state, call }) => {
    assert.equal((await post('/api/send', { text: '打开淘股吧，点击登录并显示二维码截图' })).status, 202);
    const during = await until(state, s => s.messages.some(m => m.attachments?.length));
    const attachment = during.messages.find(m => m.attachments?.length)!.attachments![0];
    assert.match(attachment.id, /^[a-f0-9]{48}$/);
    assert.equal(attachment.mimeType, 'image/png');
    assert.equal(JSON.stringify(during).includes(screenshotPng), false);
    const image = await call(attachment.url);
    assert.equal(image.status, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal(Number(image.headers['content-length']), Buffer.from(screenshotPng, 'base64').length);
    assert.equal(image.text, Buffer.from(screenshotPng, 'base64').toString('utf8'));
    assert.equal(image.headers['cache-control'], 'no-store');
    assert.equal((await call(attachment.url, { headers: { origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await call('/api/attachments/' + '0'.repeat(48))).status, 404);
    assert.equal((await call('/api/attachments/../../.env')).status, 404);
    assert.equal((await post('/api/cancel')).status, 200);
    const stopped = await state();
    assert.equal(stopped.messages.filter(m => m.attachments?.length).length, 2);
    assert(!stopped.messages.some(m => m.text === 'late answer must not be appended'));
    assert.equal((await call(attachment.url)).status, 200);
    assert.equal((await post('/api/reset')).status, 200);
    assert.deepEqual((await state()).messages, []);
    assert.equal((await call(attachment.url)).status, 404);
    emit!({ image: screenshotPng, mime: 'image/png' });
    assert.deepEqual((await state()).messages, []);
  });
});

test('web: model strings, filesystem paths and invalid tool images never become attachments', async () => {
  await withWeb(sink => ({
    async send() {
      sink({ image: '/etc/passwd', mime: 'image/png' });
      sink({ image: Buffer.from('not an image').toString('base64'), mime: 'image/png' });
      return `![fake](data:image/png;base64,${screenshotPng})`;
    },
    cancel() {}, close: async () => {},
  }), async ({ post, state, call }) => {
    await post('/api/send', { text: '截图' });
    const done = await until(state, s => !s.busy);
    assert(!done.messages.some(m => m.attachments?.length));
    assert.equal((await call('/etc/passwd')).status, 404);
    assert.equal((await call('/api/attachments/%2e%2e%2f.env')).status, 404);
  });
});

test('web: Conversation tool screenshot reaches HTTP attachment without base64 in chat state', async () => {
  const oldFetch = globalThis.fetch;
  const oldExecute = BrowserSession.prototype.execute;
  let requests = 0;
  // BrowserSession screenshots are JPEG bytes with no explicit MIME property.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]).toString('base64');
  BrowserSession.prototype.execute = async function(name) {
    assert.equal(name, 'browser_screenshot');
    return { ok: true, text: 'Untrusted viewport screenshot.', image: jpeg };
  };
  globalThis.fetch = async () => {
    requests++;
    const message = requests === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'shot-1', type: 'function', function: { name: 'browser_screenshot', arguments: '{}' } }] }
      : { role: 'assistant', content: '请自行扫码；我不会替你登录或交易。' };
    return new Response(JSON.stringify({ choices: [{ finish_reason: requests === 1 ? 'tool_calls' : 'stop', message }] }));
  };
  try {
    await withWeb(sink => new Conversation(config, undefined, sink), async ({ post, state, call }) => {
      await post('/api/send', { text: '截图显示到聊天' });
      const done = await until(state, s => !s.busy);
      const attachment = done.messages.find(m => m.attachments?.length)?.attachments?.[0];
      assert(attachment);
      assert.equal((await call(attachment.url)).status, 200);
      assert.equal(attachment.mimeType, 'image/jpeg');
      assert.equal((await call(attachment.url)).text, Buffer.from(jpeg, 'base64').toString('utf8'));
      assert.equal(JSON.stringify(done).includes(jpeg), false);
      assert(done.messages.some(m => m.text.includes('请自行扫码')));
      assert.equal(requests, 2);
    });
  } finally {
    globalThis.fetch = oldFetch;
    BrowserSession.prototype.execute = oldExecute;
  }
});

test('web: both CSP policies permit same-origin attachment images only', async () => {
  await withWeb(() => ({ send: async () => '', cancel() {}, close: async () => {} }), async ({ call }) => {
    const page = await call('/');
    assert.match(String(page.headers['content-security-policy']), /img-src 'self'/);
    assert.match(page.text, /img-src 'self'/);
    assert(!page.text.includes("img-src 'none'"));
    assert(!String(page.headers['content-security-policy']).includes('data:'));
  });
});

test('web: shutdown during pending cancellation still closes the owned session', async () => {
  const done = deferred<string>();
  let closes = 0;
  await withWeb(() => ({
    send: () => done.promise,
    cancel() {},
    close: async () => { closes++; done.resolve('closed'); },
  }), async ({ post, state, shutdown }) => {
    await post('/api/send', { text: 'capture' });
    const stopping = post('/api/cancel');
    await until(state, s => s.closing);
    await shutdown();
    assert.equal(closes, 1);
    await stopping;
  });
  assert.equal(closes, 1);
});
