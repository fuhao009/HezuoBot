import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls } from '../src/openai-chat-protocol.ts';
import { ChatRepeatGuard } from '../src/chat-repeat-guard.ts';

const call = (id: string, name = 'tool', args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });

test('protocol accepts tool counts, identifiers, names, arguments and reasoning beyond former quotas', () => {
  const calls = new ChatToolCalls();
  const payload = Array.from({ length: 40 }, (_, i) => call(`id-${i}-${'x'.repeat(300)}`, 'tool_'.repeat(20), 'x'.repeat(7000)));
  calls.add(payload, false);
  assert.equal(calls.finish('tool_calls', false).length, 40);
  const streamed = new ChatToolCalls();
  streamed.add([{ ...call('large-index', 'tool', 'x'.repeat(300000)), index: 1000 }], true);
  assert.equal(streamed.finish('tool_calls', false)[0].function.arguments.length, 300000);
  const reasoning = new ChatReasoningDetails();
  reasoning.add([{ text: 'x'.repeat(300000) }]);
  assert.equal(reasoning.blocks.length, 1);
});

test('protocol still rejects malformed structures, indexes and duplicate correlation IDs', () => {
  for (const index of [-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ChatToolCalls().add([{ ...call('id'), index }], true), ChatProtocolError);
  }
  assert.throws(() => new ChatToolCalls().add({}, false), ChatProtocolError);
  assert.throws(() => new ChatReasoningDetails().add(['invalid']), ChatProtocolError);
  const calls = new ChatToolCalls();
  calls.add([call('same'), call('same')], false);
  assert.throws(() => calls.finish('tool_calls', false), ChatProtocolError);
});

test('repeat guard never annotates or intercepts repeated successes or failures', () => {
  const guard = new ChatRepeatGuard();
  for (let i = 0; i < 100; i++) {
    for (const ok of [true, false]) assert.equal(guard.noteAfter('tool', '{}', { ok, text: 'same' }), undefined);
  }
});
