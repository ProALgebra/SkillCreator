import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextCharLimit,
  fitsContext,
  MAX_CONVERSATION_CHARS,
  MAX_CONVERSATION_PARTS,
  splitConversation,
  type ConversationPart,
} from '../src/context.js';
import { defaults } from '../src/settings.js';
import { CuratorError } from '../src/errors.js';

const settings = (tokens: number) => ({
  ...defaults,
  limits: { ...defaults.limits, max_context_tokens: tokens },
});
const errorCode = (code: string) => (error: unknown) =>
  error instanceof CuratorError && error.code === code;

function complete(source: string, parts: ConversationPart[], cap: number) {
  let end = 0;
  let rebuilt = '';
  for (const part of parts) {
    assert.ok(part.start >= 0 && part.start <= end, 'Parts must cover the source without gaps');
    assert.ok(part.end > end, 'Every part must extend coverage');
    assert.ok(part.content.length <= cap, 'Every part must respect the character budget');
    assert.equal(part.content, source.slice(part.start, part.end));
    rebuilt += part.content.slice(end - part.start);
    end = part.end;
  }
  assert.equal(end, source.length);
  assert.equal(rebuilt, source, 'The complete source must survive splitting exactly');
}

test('context budgeting reserves generated output and protocol overhead before input', () => {
  const limit = contextCharLimit(settings(10_000), { max_tokens: 2000 });
  assert.equal(limit, 22_500);
  assert.ok(contextCharLimit(settings(10_000), { max_tokens: 4000 }) < limit);
  assert.ok(contextCharLimit(settings(10_000)) < 30_000);
  assert.equal(contextCharLimit(settings(200), { max_tokens: 200 }), 0);
  assert.equal(fitsContext({}, settings(200), { max_tokens: 200 }), false);
  assert.throws(() => contextCharLimit(settings(0)), errorCode('validation_error'));
  assert.throws(
    () => contextCharLimit(settings(10_000), { max_tokens: -1 }),
    errorCode('validation_error'),
  );
});

test('the entire serialized JSON request must fit, including escaped source and prompt metadata', () => {
  const config = settings(1000);
  const execution = { max_tokens: 300 };
  const limit = contextCharLimit(config, execution);
  assert.equal(fitsContext('a'.repeat(limit - 2), config, execution), true);
  assert.equal(fitsContext('a'.repeat(limit - 1), config, execution), false);
  assert.equal(fitsContext('"'.repeat(limit / 2), config, execution), false);
  assert.equal(
    fitsContext({ prompt: 'Instructions', source: 'a'.repeat(limit - 2) }, config, execution),
    false,
  );
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const value of [undefined, cyclic, 1n])
    assert.equal(fitsContext(value, config, execution), false);
});

test('SDK JSON is split at complete message boundaries and remains the exact original source', () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    type: index % 2 ? 'assistant' : 'user',
    content: [{ type: 'text', text: `message ${index}: ` + 'details '.repeat(8) }],
  }));
  const source = JSON.stringify(messages, null, 2);
  const parts = splitConversation(source, 650, 0);
  complete(source, parts, 650);
  assert.ok(parts.length > 1);
  for (const part of parts.slice(0, -1)) assert.ok(part.content.endsWith(','));
  assert.deepEqual(splitConversation(source, 650, 0), parts, 'Splitting must be deterministic');
});

test('tool calls and results remain together when their combined messages fit', () => {
  const call = {
    role: 'assistant',
    tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'test' } }],
  };
  const result = { role: 'tool', tool_call_id: 'fixture-call', content: 'Tests passed.' };
  const source = JSON.stringify([
    { role: 'user', content: 'Describe the issue. '.repeat(12) },
    call,
    result,
    { role: 'assistant', content: 'Final explanation. '.repeat(12) },
  ]);
  const cap = JSON.stringify([call, result]).length + 10;
  const parts = splitConversation(source, cap);
  complete(source, parts, cap);
  assert.ok(
    parts.some(
      (part) =>
        part.content.includes(JSON.stringify(call)) &&
        part.content.includes(JSON.stringify(result)),
    ),
    'An adjacent tool call/result pair that fits must stay in a shared part',
  );
});

test('one oversized tool result is fully covered rather than omitted or truncated', () => {
  const source = JSON.stringify([
    {
      type: 'assistant',
      content: [
        {
          type: 'tool',
          id: 'oversized-tool',
          input: { command: 'test' },
          result: { output: 'Detailed diagnostic output. '.repeat(900) },
        },
      ],
    },
    { type: 'user', content: [{ type: 'text', text: 'Use the project fixture instead.' }] },
  ]);
  const parts = splitConversation(source, 600, 30);
  complete(source, parts, 600);
  assert.ok(parts.length > 2);
  assert.ok(parts.at(-1)!.content.includes('Use the project fixture instead.'));
});

test('plain text prefers paragraphs and preserves overlapping source ranges', () => {
  const paragraph = 'A diagnostic paragraph with reproducible observations. '.repeat(2) + '\n\n';
  const source = paragraph.repeat(8);
  const parts = splitConversation(source, 300, 20);
  complete(source, parts, 300);
  assert.ok(parts.slice(0, -1).every((part) => part.content.endsWith('\n\n')));
  assert.ok(parts.slice(1).some((part, index) => part.start < parts[index]!.end));
});

test('hard splits and overlap do not divide Unicode surrogate pairs', () => {
  const source = '🙂🧪Проверка результата\n'.repeat(80);
  const parts = splitConversation(source, 47, 9);
  complete(source, parts, 47);
  for (const part of parts) {
    assert.equal(/^[\uDC00-\uDFFF]/.test(part.content), false);
    assert.equal(/[\uD800-\uDBFF]$/.test(part.content), false);
  }
  assert.throws(() => splitConversation('🙂', 1), errorCode('budget_exceeded'));
});

test('tiny limits make forward progress and invalid arguments fail explicitly', () => {
  complete('abcde', splitConversation('abcde', 1), 1);
  assert.deepEqual(splitConversation('', 10), []);
  for (const cap of [0, -1, 2.5, Number.NaN])
    assert.throws(() => splitConversation('source', cap), errorCode('validation_error'));
  assert.throws(() => splitConversation('source', 20, -1), errorCode('validation_error'));
});

test('source and part-count caps reject the full analysis instead of returning a partial prefix', () => {
  assert.throws(
    () => splitConversation('a'.repeat(MAX_CONVERSATION_CHARS + 1), 20_000),
    errorCode('budget_exceeded'),
  );
  assert.throws(
    () => splitConversation('a'.repeat(MAX_CONVERSATION_PARTS + 1), 1, 0),
    errorCode('budget_exceeded'),
  );
  const source = 'a'.repeat(MAX_CONVERSATION_PARTS);
  const parts = splitConversation(source, 1, 0);
  assert.equal(parts.length, MAX_CONVERSATION_PARTS);
  complete(source, parts, 1);
});
