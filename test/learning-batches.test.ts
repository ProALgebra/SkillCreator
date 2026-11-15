import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { LearningService, LEARNING_SYSTEM_PROMPT } from '../src/learning.js';
import { defaults } from '../src/settings.js';
import { contextCharLimit } from '../src/context.js';
import { fixture, scope, code } from './helpers.js';

function setup(t: TestContext) {
  const { core } = fixture(t);
  const settings = structuredClone(defaults);
  settings.limits.max_context_tokens = 6000;
  const learning = new LearningService(core.store, () => settings);
  const cap = contextCharLimit(settings);
  const overhead = JSON.stringify({
    system_prompt: LEARNING_SYSTEM_PROMPT,
    sessions: [],
    source_refs: [],
  }).length;
  const medium = Math.floor((cap - overhead - 600) * 0.6);
  assert.ok(medium > 0);
  const ingest = (session: string, content: string, stage = 'done') =>
    learning.ingest(scope, 'alice', {
      source_instance: 'verified-import',
      session_id: session,
      stage_id: stage,
      content,
      verified: true,
      source_refs: ['shared-import-alias'],
    })!;
  return { core, settings, learning, cap, overhead, medium, ingest };
}

const candidate = {
  title: 'A demonstrated retry procedure',
  problem: 'Transient failures require bounded retries.',
  solution: 'Persist the marker, then retry transient failures with a bounded delay.',
  conditions: [],
  evidence: ['Persist the marker before retrying.'],
  failures: [],
  confidence: 0.9,
  reusability_score: 0.9,
};

test('learning manifests bind a bounded batch without storing transcript text and retain continuation', (t) => {
  const f = setup(t);
  const first = f.ingest('one', 'first-record-marker\n' + 'x'.repeat(f.medium));
  const second = f.ingest('two', 'second-record-marker\n' + 'y'.repeat(f.medium));
  const payload = f.learning.prepare(scope);
  assert.deepEqual(payload.session_ids, [first.id]);
  assert.deepEqual(payload.source_refs, [first.id]);
  assert.deepEqual(payload.learning_batch.included, [
    { record_id: first.id, content_hash: first.content_hash },
  ]);
  assert.deepEqual(payload.learning_batch.deferred_ids, [second.id]);
  assert.equal(JSON.stringify(payload).includes('first-record-marker'), false);
  const context = f.learning.materialize(scope, payload);
  assert.deepEqual(
    context.sessions.map((s) => s.record_id),
    [first.id],
  );
  assert.ok(JSON.stringify(context).length <= f.cap);

  f.learning.markProcessedExact(scope, payload.session_ids);
  const next = f.learning.prepare(scope);
  assert.deepEqual(next.session_ids, [second.id]);
  assert.equal(f.learning.sessions(scope).find((s) => s.id === second.id)!.processed, false);
});

test('canonical batch citations reject quotations from an omitted stage sharing session and provenance aliases', (t) => {
  const f = setup(t);
  const included = f.ingest('shared-session', candidate.evidence[0]!, 'first');
  const hiddenQuote = 'This quotation belongs only to the omitted stage.';
  const omitted = f.ingest('shared-session', hiddenQuote + 'z'.repeat(f.cap), 'second');
  const payload = f.learning.prepare(scope, ['shared-session']);
  assert.deepEqual(payload.session_ids, [included.id]);
  assert.deepEqual(payload.learning_batch.skipped, [
    { record_id: omitted.id, reason: 'record_exceeds_context_limit' },
  ]);
  for (const source_refs of [[included.id], ['shared-session'], ['shared-import-alias']])
    assert.throws(
      () =>
        f.learning.acceptResult(
          scope,
          'alice',
          { candidates: [{ ...candidate, evidence: [hiddenQuote], source_refs }] },
          payload.source_refs,
          payload,
        ),
      code('validation_error'),
    );
  assert.equal(f.learning.candidates(scope).length, 0);
  const [accepted] = f.learning.acceptResult(
    scope,
    'alice',
    { candidates: [{ ...candidate, source_refs: [included.id] }] },
    payload.source_refs,
    payload,
  );
  assert.deepEqual(accepted!.source_refs, [included.id]);
});

test('a prepared learning batch neither expands for new same-session stages nor silently shrinks', (t) => {
  const f = setup(t);
  const first = f.ingest('shared', candidate.evidence[0]!, 'first');
  const payload = f.learning.prepare(scope, ['shared']);
  const later = f.ingest('shared', 'A later independent result.', 'second');
  assert.deepEqual(
    f.learning.materialize(scope, payload).sessions.map((s) => s.record_id),
    [first.id],
  );
  f.learning.markProcessedExact(scope, payload.session_ids);
  assert.equal(f.learning.sessions(scope).find((s) => s.id === later.id)!.processed, false);

  f.settings.limits.max_context_tokens = 1;
  assert.throws(() => f.learning.materialize(scope, payload), code('budget_exceeded'));
  f.settings.limits.max_context_tokens = 6000;
  f.core.store.put('sessions', first.id, { ...first, content: 'Mutated source text.' });
  assert.throws(() => f.learning.materialize(scope, payload), code('revision_conflict'));
});

test('context accounting includes the prompt, serialization and response reserve; oversized records remain unprocessed', (t) => {
  const f = setup(t);
  const large = f.ingest('large', 'x'.repeat(f.cap - 100));
  const small = f.ingest('small', candidate.evidence[0]!);
  const payload = f.learning.prepare(scope);
  assert.deepEqual(payload.session_ids, [small.id]);
  assert.deepEqual(payload.learning_batch.skipped, [
    { record_id: large.id, reason: 'record_exceeds_context_limit' },
  ]);
  const noFit = f.learning.prepare(scope, [large.id]);
  assert.deepEqual(noFit.session_ids, []);
  assert.throws(() => f.learning.materialize(scope, noFit), code('budget_exceeded'));
  assert.throws(
    () => f.learning.materialize(scope, payload, false, { max_tokens: 5900 }),
    code('budget_exceeded'),
  );
  assert.equal(f.learning.sessions(scope).find((s) => s.id === large.id)!.processed, false);
});

test('default learning skips processed records while explicit immutable IDs allow deliberate reprocessing', (t) => {
  const f = setup(t);
  const first = f.ingest('shared', 'Earlier verified result.', 'first');
  const second = f.ingest('shared', 'Later verified result.', 'second');
  f.learning.markProcessedExact(scope, [first.id]);
  assert.deepEqual(f.learning.prepare(scope).session_ids, [second.id]);
  assert.deepEqual(f.learning.prepare(scope, [first.id]).session_ids, [first.id]);
  assert.throws(
    () => f.learning.markProcessedExact(scope, [second.id, 'missing']),
    code('not_found'),
  );
  assert.equal(f.learning.sessions(scope).find((s) => s.id === second.id)!.processed, false);
});

test('external learning requires opt-in at preparation and delivery without exposing an empty successful review', (t) => {
  const f = setup(t);
  const record = f.ingest('external', candidate.evidence[0]!);
  assert.throws(() => f.learning.prepare(scope, undefined, true), code('forbidden'));
  f.settings.privacy.send_raw_transcripts_to_external = true;
  const payload = f.learning.prepare(scope, undefined, true);
  assert.deepEqual(f.learning.materialize(scope, payload, true).source_refs, [record.id]);
  f.settings.privacy.send_raw_transcripts_to_external = false;
  assert.throws(() => f.learning.materialize(scope, payload, true), code('forbidden'));
  assert.equal(f.learning.sessions(scope)[0]!.processed, false);
});

test('a learning manifest rejects changed reference lists, foreign sources and malformed duplicate IDs', (t) => {
  const f = setup(t);
  f.ingest('one', candidate.evidence[0]!);
  const payload = f.learning.prepare(scope);
  assert.throws(
    () => f.learning.materialize(scope, { ...payload, source_refs: ['one'] }),
    code('validation_error'),
  );
  assert.throws(
    () => f.learning.materialize({ ...scope, workspace_id: 'foreign' }, payload),
    code('not_found'),
  );
  assert.throws(
    () =>
      f.learning.materialize(scope, {
        ...payload,
        learning_batch: { ...payload.learning_batch, deferred_ids: payload.session_ids },
      }),
    code('validation_error'),
  );
});
