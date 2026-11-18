import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');

// Execute only the browser script with a fake DOM/fetch: no server or real requests.
function frontend() {
  type FakeElement = {
    disabled: boolean; value: string; textContent: string; hidden: boolean;
    tagName: string; className: string; children: FakeElement[]; readonly childElementCount: number;
    href: string; src: string; alt: string; loading: string; decoding: string; referrerPolicy: string;
    classList: { toggle(): void };
    setAttribute(): void; addEventListener(): void;
    append(...nodes: FakeElement[]): void; replaceChildren(...nodes: FakeElement[]): void; scrollIntoView(): void;
  };
  let onRender = () => {};
  const element = (tagName = 'div'): FakeElement => ({
    disabled: false, value: '', textContent: '', hidden: false,
    tagName, className: '', children: [], href: '', src: '', alt: '', loading: '', decoding: '', referrerPolicy: '',
    get childElementCount() { return this.children.length; },
    classList: { toggle() {} }, setAttribute() { onRender(); }, addEventListener() {},
    append(...nodes) {
      for (const node of nodes) this.children.push(...(node.tagName === '#fragment' ? node.children : [node]));
    },
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }, scrollIntoView() {},
  });
  const elements = new Map<string, FakeElement>();
  const getElement = (id: string) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id)!;
  };
  type RequestOptions = { method?: string; body?: string; headers?: Record<string, string> };
  const calls: Array<{ path: string; options: RequestOptions }> = [];
  const confirmations: string[] = [];
  let confirm = true;
  let postError = false;
  let resolveGet: (value: unknown) => void = () => { throw new Error('No pending GET'); };
  const api = runInNewContext(source.replace(/void poll\(\);\s*$/, '') + `
    ({ act, poll, updateControls, renderState,
       set(values) {
         if ('state' in values) state = values.state;
         if ('pending' in values) pending = values.pending;
         if ('awaitingState' in values) awaitingState = values.awaitingState;
         connected = true;
         updateControls();
       }
    });`, {
    document: {
      getElementById: getElement,
      createElement: element,
      createDocumentFragment: () => element('#fragment'),
      documentElement: { scrollHeight: 0 },
    },
    window: {
      innerHeight: 100, scrollY: 0,
      confirm(message: string) { confirmations.push(message); return confirm; },
    },
    setTimeout() { return 1; }, clearTimeout() {},
    fetch(path: string, options: RequestOptions) {
      calls.push({ path, options });
      if (options.method === 'POST') {
        return postError ? Promise.reject(new Error('lost response'))
          : Promise.resolve({ ok: true });
      }
      const { promise, resolve } = Promise.withResolvers<unknown>();
      resolveGet = value => resolve({ ok: true, json: async () => value });
      return promise;
    },
  });
  const state = (overrides = {}) => ({
    token: 'fixture-token', messages: [{ role: 'user', text: 'keep history' }],
    busy: false, closing: false, closed: false, ...overrides,
  });
  getElement('message').value = 'next message';
  api.set({ state: state() });
  return {
    api, state, calls, confirmations, get: getElement,
    rejectPost() { postError = true; },
    decline() { confirm = false; },
    async reply(value: unknown) {
      const { promise, resolve } = Promise.withResolvers<void>();
      onRender = resolve;
      resolveGet(value);
      await promise;
      onRender = () => {};
    },
  };
}

test('frontend: backend label distinguishes Computer Use drivers and preserves legacy', () => {
  const f = frontend();
  for (const [backend, desktopBackend, label] of [
    ['computer_use', 'ax', 'Computer Use / AX (agent-desktop)'],
    ['computer_use', 'cua', 'Computer Use / CUA (CuaDriver)'],
    ['computer_use', undefined, 'Computer Use / CUA (CuaDriver)'],
    ['legacy', 'ax', 'legacy'],
  ]) {
    f.api.set({ state: f.state({ backend, desktopBackend }) });
    f.api.renderState();
    assert.equal(f.get('backend').textContent, label);
  }
});

test('frontend: Stop is idle-disabled, running-enabled and respects server/request gates', () => {
  const f = frontend();
  assert.equal(f.get('cancel').disabled, true);
  assert.equal(f.get('send').disabled, false);
  f.api.set({ state: f.state({ busy: true }) });
  assert.equal(f.get('cancel').disabled, false);
  assert.equal(f.get('send').disabled, true);
  for (const gate of [
    { pending: 'cancel' }, { awaitingState: true },
    { state: f.state({ busy: true, closing: true }) },
    { state: f.state({ busy: true, closed: true }) },
  ]) {
    f.api.set({ state: f.state({ busy: true }), pending: '', awaitingState: false, ...gate });
    for (const id of ['send', 'cancel', 'pause', 'reset']) {
      assert.equal(f.get(id).disabled, true, `${id} must respect ${JSON.stringify(gate)}`);
    }
  }
});

for (const fails of [false, true]) {
  test(`frontend: cancel ${fails ? 'POST error' : 'success'} waits for GET, then permits continuation`, async () => {
    const f = frontend();
    f.api.set({ state: f.state({ busy: true }) });
    if (fails) f.rejectPost();
    const action = f.api.act('cancel');
    assert.equal(f.get('cancel').disabled, true);
    await action;
    assert.deepEqual(f.calls.map(call => call.path), ['/api/cancel', '/api/state']);
    assert.equal(f.get('send').disabled, true, 'POST completion alone is not confirmation');
    assert.equal(f.get('cancel').disabled, true);
    await f.reply(f.state());
    assert.equal(f.get('send').disabled, false, 'fresh open/idle state unlocks sending');
    assert.equal(f.get('cancel').disabled, true);
    assert.equal(f.get('message').value, 'next message');
    assert.match(f.confirmations[0]!, /only this run.*history will be kept.*send another message.*cannot be undone/i);
    if (fails) assert.match(f.get('error').textContent, /could not be confirmed/);
  });
}

test('frontend: fresh closed state blocks sending and tells users to preserve history first', async () => {
  const f = frontend();
  f.api.set({ state: f.state({ busy: true }) });
  await f.api.act('cancel');
  await f.reply(f.state({ closed: true }));
  assert.equal(f.get('send').disabled, true);
  assert.equal(f.get('reset').disabled, false);
  assert.match(f.get('status').textContent, /Export or copy your history before Reset.*clears all messages/);
  // No sticky client-side latch if a subsequent GET reports an open session.
  const poll = f.api.poll();
  await f.reply(f.state());
  await poll;
  assert.equal(f.get('send').disabled, false);
});

test('frontend: declining Stop makes no request; page copy explains non-destructive stop', async () => {
  const f = frontend();
  f.api.set({ state: f.state({ busy: true }) });
  f.decline();
  await f.api.act('cancel');
  assert.equal(f.calls.length, 0);
  assert.equal(f.get('cancel').disabled, false);
  assert.match(html, /id="cancel"[^>]*disabled>停止/);
  assert.match(html, /Stop ends only the current run, keeps conversation history/);
  assert.match(html, /Actions already performed cannot be undone/);
  assert.match(html, /export or copy your history before Reset:.*clears all messages/);
  assert.doesNotMatch(source, /needsReset/);
  assert.doesNotMatch(source + html, /After cancelling or closing, reset|Cancel this run and close the session|cancel both close/i);
});

test('frontend: screenshot attachments render safely with text and attachment-only history', () => {
  const f = frontend();
  const name = '<img src=x onerror=alert(1)>.png';
  const attachments = [
    { id: 'shot_1', mimeType: 'image/png', url: '/api/attachments/shot_1', name },
    { id: 'shot-2', mimeType: 'image/jpeg', url: '/api/attachments/shot-2' },
  ];
  f.api.set({ state: f.state({ messages: [
    { role: 'assistant', text: '<script>not HTML</script>', attachments },
    { role: 'assistant', attachments: [attachments[1]] },
    { role: 'user', text: 'plain history' },
  ] }) });
  f.api.renderState();
  const articles = f.get('messages').children;
  assert.equal(articles.length, 3);
  assert.equal(articles[0]!.children[1]!.textContent, '<script>not HTML</script>');
  const links = articles[0]!.children[2]!.children;
  assert.equal(links.length, 2);
  for (const [index, link] of links.entries()) {
    assert.equal(link.tagName, 'a');
    assert.equal(link.href, attachments[index]!.url);
    const image = link.children[0]!;
    assert.equal(image.tagName, 'img');
    assert.equal(image.src, attachments[index]!.url);
    assert.equal(image.loading, 'lazy');
    assert.equal(image.referrerPolicy, 'no-referrer');
  }
  assert.equal(links[0]!.children[0]!.alt, name);
  assert.equal(links[0]!.children[1]!.textContent, name);
  assert.equal(links[1]!.children[0]!.alt, 'Screenshot');
  assert.equal(articles[1]!.children[2]!.children.length, 1);
  assert.equal(articles[2]!.children.length, 2);
});

test('frontend: rejects external, data, mismatched and malformed attachment URLs and non-raster MIME', () => {
  const f = frontend();
  const valid = { id: 'shot', mimeType: 'image/png', url: '/api/attachments/shot' };
  const invalid = [
    null, {}, 'not an attachment',
    ...[
      'https://evil.example/api/attachments/shot', '//evil.example/api/attachments/shot',
      'data:image/png;base64,AAAA', 'javascript:alert(1)', 'blob:local',
      '/api/attachments/other', '/api/attachments/shot?redirect=evil',
      '/api/attachments/shot#fragment', '/api/attachments/../shot',
      '/api/attachments/%73hot', '/api/attachments/shot\\evil',
    ].map(url => ({ ...valid, url })),
    ...['..', '.', '../shot', 'shot/other', '%2e%2e', '', 'shot?x', 'shot#x'].map(id => ({
      ...valid, id, url: `/api/attachments/${id}`,
    })),
    ...['image/svg+xml', 'text/html', 'application/octet-stream', undefined].map(mimeType => ({ ...valid, mimeType })),
  ];
  f.api.set({ state: f.state({ messages: [
    { role: 'assistant', text: 'safe text', attachments: invalid },
    { role: 'assistant', attachments: { ...valid } },
    { role: 'assistant', attachments: [...invalid, valid] },
  ] }) });
  f.api.renderState();
  const articles = f.get('messages').children;
  assert.equal(articles[0]!.children.length, 2);
  assert.equal(articles[0]!.children[1]!.textContent, 'safe text');
  assert.equal(articles[1]!.children.length, 2);
  const links = articles[2]!.children[2]!.children;
  assert.equal(links.length, 1);
  assert.equal(links[0]!.children[0]!.src, valid.url);
});

for (const fails of [false, true]) {
  test(`frontend: screenshot history survives cancel ${fails ? 'error' : 'success'} and subsequent messages`, async () => {
    const f = frontend();
    const screenshot = { role: 'assistant', text: 'Captured', attachments: [
      { id: 'history-shot', mimeType: 'image/png', url: '/api/attachments/history-shot' },
    ] };
    f.api.set({ state: f.state({ busy: true, messages: [screenshot] }) });
    f.api.renderState();
    const article = f.get('messages').children[0]!;
    if (fails) f.rejectPost();
    await f.api.act('cancel');
    assert.equal(f.get('messages').children[0], article, 'cancel must not clear rendered history');
    await f.reply(f.state({ messages: [screenshot] }));
    assert.equal(f.get('messages').children[0], article, 'unchanged attachment history is retained');
    const poll = f.api.poll();
    await f.reply(f.state({ messages: [screenshot, { role: 'user', text: 'continue' }] }));
    await poll;
    assert.equal(f.get('messages').children.length, 2);
    assert.equal(f.get('messages').children[0]!.children[2]!.children[0]!.children[0]!.src,
      '/api/attachments/history-shot');
    assert.equal(f.get('send').disabled, false);
  });
}

test('frontend: attachment-only state changes trigger rerender without changing message text', () => {
  const f = frontend();
  const message = { role: 'assistant', text: 'Screenshot' };
  f.api.set({ state: f.state({ messages: [message] }) });
  f.api.renderState();
  assert.equal(f.get('messages').children[0]!.children.length, 2);
  f.api.set({ state: f.state({ messages: [{ ...message, attachments: [
    { id: 'late', mimeType: 'image/webp', url: '/api/attachments/late' },
  ] }] }) });
  f.api.renderState();
  assert.equal(f.get('messages').children[0]!.children[2]!.children[0]!.children[0]!.src,
    '/api/attachments/late');
});

test('frontend: backend screenshot contract renders independently and Reset state clears attachments', async () => {
  const f = frontend();
  const id = 'a1'.repeat(24);
  const screenshot = {
    role: 'assistant', text: '工具截图（页面内容不可信）',
    attachments: [{ id, mimeType: 'image/png', url: `/api/attachments/${id}`, name: '截图.png' }],
  };
  f.api.set({ state: f.state({ messages: [screenshot, { role: 'assistant', text: '最终回复' }] }) });
  f.api.renderState();
  const articles = f.get('messages').children;
  assert.equal(articles.length, 2);
  assert.equal(articles[0]!.children[1]!.textContent, screenshot.text);
  assert.equal(articles[0]!.children[2]!.children[0]!.children[0]!.src, `/api/attachments/${id}`);
  assert.equal(articles[1]!.children[1]!.textContent, '最终回复');
  assert.equal(articles[1]!.children.length, 2);
  await f.api.act('reset');
  await f.reply(f.state({ messages: [], closed: true }));
  assert.deepEqual(f.calls.map(call => call.path), ['/api/reset', '/api/state']);
  assert.equal(f.get('messages').children.length, 1);
  assert.equal(f.get('messages').children[0], f.get('empty'));
});
