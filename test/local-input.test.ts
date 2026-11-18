import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { LocalInput, type LocalLoginPrompt } from '../src/local-input.ts';

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  modes: boolean[] = [];
  setRawMode(value: boolean) { this.isRaw = value; this.modes.push(value); return this; }
  isPaused() { return this.paused; }
  resume() { this.paused = false; return this; }
  pause() { this.paused = true; return this; }
  send(text: string | Buffer) { this.emit('data', text); }
}
class FakeOutput {
  isTTY = true;
  text = '';
  write(text: string | Uint8Array) { this.text += text.toString(); return true; }
}
const tick = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};
function fixture() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const local = new LocalInput(input, output);
  const controller = new AbortController();
  return { input, output, local, controller, signal: controller.signal };
}
function clean(input: FakeInput, signal?: AbortSignal) {
  for (const event of ['data', 'end', 'close', 'error']) assert.equal(input.listenerCount(event), 0);
  if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0);
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
}

test('collect returns local credentials without any input echo or extra chunk leakage', async () => {
  const { input, output, local, signal } = fixture();
  const api: LocalLoginPrompt = local;
  const result = api.collect(signal);
  assert.equal(input.isRaw, true);
  input.send('private-account\rpassword-pasted-early\n');
  await tick();
  input.send('sensitive-password\rsecret-tail\n');
  assert.deepEqual(await result, { account: 'private-account', password: 'sensitive-password' });
  for (const secret of ['private-account', 'sensitive-password', 'password-pasted-early', 'secret-tail']) {
    assert.equal(output.text.includes(secret), false);
  }
  clean(input, signal);
});

test('pasted multiline password is discarded, never consumed by the next CLI question', async () => {
  const { input, output, local, signal } = fixture();
  const credentials = local.collect(signal);
  input.send('account\n');
  await tick();
  input.send('password\nyes\n');
  await credentials;
  assert.equal(await local.confirm(signal), true);
  const next = local.question('Next: ');
  input.send('help\n');
  assert.equal(await next, 'help');
  assert.equal(output.text.includes('password\n'), false);
  clean(input, signal);
});

test('compatibility confirmation returns immediately without prompting or reading', async () => {
  const { input, output, local, signal } = fixture();
  assert.equal(await local.confirm(signal), true);
  assert.equal(output.text, '');
  clean(input, signal);
});

for (const stream of ['input', 'output'] as const) {
  test(`refuses non-TTY ${stream} without reading or raw mode`, async () => {
    const f = fixture();
    f[stream].isTTY = false;
    assert.equal(await f.local.collect(f.signal), null);
    assert.equal(await f.local.confirm(f.signal), true);
    assert.equal(await f.local.question('ignored'), '');
    assert.equal(f.output.text, '');
    assert.deepEqual(f.input.modes, []);
    clean(f.input, f.signal);
  });
}

test('pre-abort does not install listeners or prompt', async () => {
  const f = fixture();
  f.controller.abort();
  assert.equal(await f.local.collect(f.signal), null);
  assert.equal(await f.local.confirm(f.signal), true);
  assert.equal(f.output.text, '');
  assert.deepEqual(f.input.modes, []);
  clean(f.input, f.signal);
});

for (const stage of ['account', 'password'] as const) {
  test(`abort during ${stage} resolves cancellation and cleans listeners`, async () => {
    const f = fixture();
    const result = f.local.collect(f.signal);
    if (stage === 'password') { f.input.send('account\n'); await tick(); f.input.send('partial-secret'); }
    f.controller.abort();
    assert.equal(await result, null);
    assert.equal(f.output.text.includes('partial-secret'), false);
    clean(f.input, f.signal);
    const next = f.local.question('Continue: ');
    f.input.send('ok\n');
    assert.equal(await next, 'ok');
  });
}

for (const control of ['\u0003', '\u0004']) {
  test(`raw cancellation ${JSON.stringify(control)} permits next CLI question`, async () => {
    const f = fixture();
    const result = f.local.collect(f.signal);
    f.input.send(`partial${control}`);
    assert.equal(await result, null);
    clean(f.input, f.signal);
    const next = f.local.question('Continue: ');
    f.input.send('continue\n');
    assert.equal(await next, 'continue');
  });
}

for (const event of ['end', 'close', 'error']) {
  test(`${event} cancels pending input and closes owner`, async () => {
    const f = fixture();
    const result = f.local.collect(f.signal);
    f.input.emit(event, new Error('terminal failure'));
    assert.equal(await result, null);
    clean(f.input, f.signal);
    assert.equal(await f.local.question('not written'), '');
  });
}

test('close is idempotent, cancels pending input and refuses future input', async () => {
  const f = fixture();
  const result = f.local.question('CLI: ');
  f.local.close();
  f.local.close();
  assert.equal(await result, '');
  assert.equal(await f.local.question('ignored'), '');
  clean(f.input, f.signal);
});

test('competing questions are rejected without disrupting the owner', async () => {
  const f = fixture();
  const result = f.local.question('CLI: ');
  await assert.rejects(f.local.collect(f.signal), /already in use/);
  assert.equal(f.input.listenerCount('data'), 1);
  f.input.send('hello\r');
  assert.equal(await result, 'hello');
  clean(f.input);
});

test('local input accepts text beyond the former 4096-character quota', async () => {
  const f = fixture();
  const result = f.local.question('CLI: ');
  const text = '密'.repeat(10000);
  f.input.send(`${text}\n`);
  assert.equal(await result, text);
  assert.equal(f.output.text, 'CLI: ');
  clean(f.input);
});

test('UTF-8 split chunks, deletion, Ctrl-U and arrow keys work without echo', async () => {
  const f = fixture();
  const result = f.local.question('CLI: ');
  f.input.send('discard\u0015');
  const bytes = Buffer.from('密');
  f.input.send(bytes.subarray(0, 1));
  f.input.send(bytes.subarray(1));
  f.input.send('x\u007f\u001b[D\r');
  assert.equal(await result, '密');
  assert.equal(f.output.text, 'CLI: ');
  clean(f.input);
});

test('restores pre-existing raw mode and flowing state without process signal handlers', async () => {
  const f = fixture();
  f.input.isRaw = true;
  f.input.paused = false;
  const before = process.listenerCount('SIGINT');
  const result = f.local.question('CLI: ');
  f.input.send('no\n');
  assert.equal(await result, 'no');
  assert.equal(f.input.isRaw, true);
  assert.equal(f.input.paused, false);
  assert.equal(process.listenerCount('SIGINT'), before);
  assert.equal(getEventListeners(f.signal, 'abort').length, 0);
});

test('abort after final line but before promise continuation still cancels', async () => {
  const f = fixture();
  const result = f.local.collect(f.signal);
  f.input.send('account\n');
  await tick();
  f.input.send('password\n');
  f.controller.abort();
  assert.equal(await result, null);
  clean(f.input, f.signal);
});
