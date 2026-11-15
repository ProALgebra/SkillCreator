import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { LearningContinuationService } from '../src/learning-continuation.js';
import { LearningService, LEARNING_SYSTEM_PROMPT } from '../src/learning.js';
import { JobService, ExecutorPreflightError, type Job } from '../src/jobs.js';
import { CuratorError } from '../src/errors.js';
import { contextCharLimit } from '../src/context.js';
import { defaults } from '../src/settings.js';
import { hash } from '../src/security.js';
import { fixture, scope, code } from './helpers.js';

function setup(
  t: TestContext,
  behavior?: (job: Job) => Promise<{ output: unknown; cost_usd: number }>,
) {
  const { core } = fixture(t);
  const settings = structuredClone(defaults);
  settings.limits.max_context_tokens = 6000;
  const learning = new LearningService(core.store, () => settings);
  let continuation: LearningContinuationService;
  const delivered: string[][] = [];
  const jobs = new JobService(
    core.store,
    () => settings,
    (job, result) =>
      core.store.transaction(() => {
        learning.acceptResult(scope, 'alice', result, job.source_refs, job.payload);
        learning.markProcessedExact(scope, job.payload.session_ids as string[]);
        return [];
      }),
    {
      direct: async ({ job }) => {
        try {
          continuation.assertCanExecute(job);
          learning.materialize(scope, job.payload, false, job.execution);
        } catch (error) {
          if (error instanceof CuratorError) throw new ExecutorPreflightError(error);
          throw error;
        }
        delivered.push(job.source_refs);
        return behavior
          ? behavior(job)
          : { output: { candidates: [] }, cost_usd: job.max_cost_usd };
      },
    },
  );
  continuation = new LearningContinuationService(core.store, learning, jobs, () => settings);
  const cap = contextCharLimit(settings);
  const overhead = JSON.stringify({
    system_prompt: LEARNING_SYSTEM_PROMPT,
    sessions: [],
    source_refs: [],
  }).length;
  const medium = Math.floor((cap - overhead - 600) * 0.6);
  const records = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        learning.ingest(scope, 'alice', {
          source_instance: 'verified-import',
          session_id: 'source-' + index,
          stage_id: 'done',
          content: 'Unique transcript ' + index + '\n' + 'x'.repeat(medium),
          verified: true,
        })!,
    );
  const plan = (marker = 'run', maxCost = 0.6) =>
    continuation.plan(scope, undefined, false, { mode: 'direct', max_cost_usd: maxCost }, marker);
  return { core, settings, learning, jobs, continuation, delivered, cap, records, plan };
}

test('learning continuation plans without writes, then processes every frozen batch sequentially within one allowance', async (t) => {
  const f = setup(t);
  const records = f.records(3);
  const before = f.core.store.all('control');
  const plan = f.plan();
  assert.equal(plan.batches.length, 3);
  assert.equal(plan.execution.max_cost_usd, 0.6 / 5);
  assert.deepEqual(f.core.store.all('control'), before);
  assert.equal(f.jobs.list(scope).length, 0);
  assert.equal(JSON.stringify(plan).includes('Unique transcript'), false);

  const first = f.continuation.start(scope, 'alice', plan, 'run');
  assert.equal(f.jobs.list(scope).length, 1);
  assert.equal(f.continuation.start(scope, 'alice', plan, 'run').job_id, first.job_id);
  assert.equal('batches' in first, false, 'private coordinator state does not leak into jobs');
  for (let index = 0; index < records.length; index++) {
    await f.jobs.drain();
    assert.equal(f.delivered.length, index + 1);
    assert.equal(f.learning.sessions(scope).filter((s) => s.processed).length, index + 1);
    assert.equal(f.continuation.advance(), index + 1 < records.length ? 1 : 0);
  }
  const status = f.continuation.status(first)!;
  assert.equal(status.status, 'completed');
  assert.equal(status.batches_completed, 3);
  assert.equal(status.records_processed, 3);
  assert.equal(status.calls_used, 3);
  assert.ok(Math.abs(status.cost_usd - 0.36) < 1e-9);
  assert.equal(status.budget_total, 0.6);
  assert.deepEqual(
    f.delivered.flat(),
    records.map((s) => s.id),
  );
  const coordinator = f.core.store
    .all<{ kind?: string }>('control')
    .find((row) => row.kind === 'learning-continuation');
  assert.equal(JSON.stringify(coordinator).includes('Unique transcript'), false);
  assert.equal(f.continuation.advance(), 0);
  assert.equal(f.jobs.list(scope).length, 3);
});

test('daily-budget refusal pauses continuation without duplicate jobs and resumes after allowance changes', async (t) => {
  const f = setup(t);
  f.records(2);
  const plan = f.plan();
  f.settings.limits.daily_cost_usd = plan.execution.max_cost_usd! * 1.1;
  const first = f.continuation.start(scope, 'alice', plan, 'run');
  await f.jobs.drain();
  for (let index = 0; index < 3; index++) assert.equal(f.continuation.advance(), 0);
  assert.equal(f.jobs.list(scope).length, 1);
  assert.equal(f.delivered.length, 1);
  assert.equal(f.continuation.status(first)!.blocked_reason, 'budget_exceeded');
  f.settings.limits.daily_cost_usd = 3;
  const reloaded = new LearningContinuationService(
    f.core.store,
    f.learning,
    f.jobs,
    () => f.settings,
  );
  assert.equal(reloaded.advance(), 1);
  assert.equal(reloaded.advance(), 0);
  await f.jobs.drain();
  reloaded.advance();
  assert.equal(reloaded.status(first)!.status, 'completed');
  assert.equal(f.jobs.list(scope).length, 2);
});

test('failed children wait for explicit retry and share the total call cap with later batches', async (t) => {
  let failures = 2;
  const f = setup(t, async () => ({
    output: failures-- > 0 ? { invalid: true } : { candidates: [] },
    cost_usd: 0,
  }));
  f.records(2);
  f.settings.analysis.max_calls = 3;
  const first = f.continuation.start(scope, 'alice', f.plan(), 'run');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) f.jobs.retry(scope, first.job_id);
    await f.jobs.drain();
    assert.equal(f.continuation.advance(), 0);
    assert.equal(f.jobs.list(scope).length, 1);
  }
  assert.equal(f.jobs.get(scope, first.job_id).status, 'completed');
  assert.equal(f.continuation.status(first)!.blocked_reason, 'budget_exceeded');
  assert.equal(f.continuation.status(first)!.calls_used, 3);
  assert.equal(f.learning.sessions(scope).filter((s) => s.processed).length, 1);
});

test('uncertain children never trigger another batch or an automatic retry', async (t) => {
  const f = setup(t, async () => {
    throw new Error('Connection ended after provider acceptance');
  });
  f.records(2);
  const first = f.continuation.start(scope, 'alice', f.plan(), 'run');
  await f.jobs.drain();
  assert.equal(f.jobs.get(scope, first.job_id).status, 'unknown_outcome');
  for (let index = 0; index < 3; index++) assert.equal(f.continuation.advance(), 0);
  assert.equal(f.continuation.status(first)!.blocked_reason, 'unknown_outcome');
  assert.equal(f.jobs.list(scope).length, 1);
  assert.equal(f.delivered.length, 1);
  assert.equal(
    f.learning.sessions(scope).some((s) => s.processed),
    false,
  );
});

test('learning pauses, missing sources and chain cancellation do not consume deferred records', async (t) => {
  const f = setup(t);
  const records = f.records(2);
  const first = f.continuation.start(scope, 'alice', f.plan(), 'run');
  await f.jobs.drain();
  f.core.store.put('control', 'pause:' + hash(scope), { learning: true });
  assert.equal(f.continuation.advance(), 0);
  assert.equal(f.continuation.status(first)!.blocked_reason, 'executor_unavailable');
  f.core.store.delete('control', 'pause:' + hash(scope));
  f.core.store.delete('sessions', records[1]!.id);
  assert.equal(f.continuation.advance(), 0);
  assert.equal(f.continuation.status(first)!.blocked_reason, 'not_found');
  assert.equal(f.continuation.cancel(scope, first.job_id)!.status, 'cancelled');
  assert.equal(f.continuation.advance(), 0);
  assert.equal(f.jobs.list(scope).length, 1);
  assert.throws(
    () => f.continuation.cancel({ ...scope, workspace_id: 'foreign' }, first.job_id),
    code('not_found'),
  );
});

test('oversized sources are explicitly reported and empty or excessive plans never create jobs', (t) => {
  const f = setup(t);
  const large = f.learning.ingest(scope, 'alice', {
    source_instance: 'verified-import',
    session_id: 'oversized',
    stage_id: 'done',
    content: 'x'.repeat(f.cap),
    verified: true,
  })!;
  const empty = f.plan();
  assert.deepEqual(empty.skipped, [
    { record_id: large.id, reason: 'record_exceeds_context_limit' },
  ]);
  assert.throws(() => f.continuation.start(scope, 'alice', empty, 'run'), code('budget_exceeded'));
  assert.equal(f.jobs.list(scope).length, 0);
  f.records(3);
  f.settings.analysis.max_calls = 2;
  assert.throws(() => f.plan(), code('budget_exceeded'));
  assert.equal(f.jobs.list(scope).length, 0);
  assert.equal(
    f.learning.sessions(scope).some((s) => s.processed),
    false,
  );
});

test('external privacy is rechecked before each continuation batch and source text remains private', async (t) => {
  const f = setup(t);
  f.records(2);
  f.settings.external_bridge.enabled = true;
  f.settings.privacy.send_raw_transcripts_to_external = true;
  const plan = f.continuation.plan(
    scope,
    undefined,
    true,
    { mode: 'external', max_cost_usd: 0.6 },
    'external-run',
  );
  const first = f.continuation.start(scope, 'alice', plan, 'external-run');
  const lease = f.jobs.lease(scope, 'external', 'worker', (job) => {
    f.continuation.assertCanExecute(job);
    return f.learning.materialize(scope, job.payload, true, job.execution);
  })!;
  assert.equal(lease.context.sessions.length, 1);
  await f.jobs.complete(scope, first.job_id, 'worker', lease.lease_token, {
    output: { candidates: [] },
    cost_usd: first.max_cost_usd,
  });
  f.settings.privacy.send_raw_transcripts_to_external = false;
  assert.equal(f.continuation.advance(), 0);
  assert.equal(f.continuation.status(first)!.blocked_reason, 'forbidden');
  assert.equal(f.jobs.list(scope).length, 1);
  assert.equal(f.learning.sessions(scope).filter((s) => s.processed).length, 1);
});

test('a rejected initial queue leaves no coordinator or job and can start after budget recovery', (t) => {
  const f = setup(t);
  f.records(2);
  const plan = f.plan();
  f.settings.limits.daily_cost_usd = 0;
  assert.throws(() => f.continuation.start(scope, 'alice', plan, 'run'), code('budget_exceeded'));
  assert.equal(f.jobs.list(scope).length, 0);
  assert.equal(
    f.core.store
      .all<{ kind?: string }>('control')
      .some((row) => row.kind === 'learning-continuation'),
    false,
  );
  f.settings.limits.daily_cost_usd = 3;
  const first = f.continuation.start(scope, 'alice', plan, 'run');
  assert.equal(f.jobs.list(scope).length, 1);
  assert.equal(f.continuation.status(first)!.batches_total, 2);
});

test('an explicit retry beyond the run call cap is refused before model delivery', async (t) => {
  const f = setup(t, async () => ({ output: { invalid: true }, cost_usd: 0 }));
  f.records(1);
  f.settings.analysis.max_calls = 1;
  const first = f.continuation.start(scope, 'alice', f.plan(), 'run');
  await f.jobs.drain();
  assert.equal(f.jobs.get(scope, first.job_id).status, 'failed');
  assert.equal(f.delivered.length, 1);
  f.jobs.retry(scope, first.job_id);
  await f.jobs.drain();
  const refused = f.jobs.get(scope, first.job_id);
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error!.code, 'budget_exceeded');
  assert.equal(f.delivered.length, 1);
  assert.equal(f.continuation.advance(), 0);
  assert.equal(f.learning.sessions(scope)[0]!.processed, false);
});

test('a zero-budget preview cannot start a paid learning continuation', (t) => {
  const f = setup(t);
  f.records(1);
  const plan = f.plan('zero-budget', 0);
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.execution.max_cost_usd, 0);
  assert.throws(
    () => f.continuation.start(scope, 'alice', plan, 'zero-budget'),
    code('budget_exceeded'),
  );
  assert.equal(f.jobs.list(scope).length, 0);
  assert.equal(f.delivered.length, 0);
});

test('retry delivery reserves only the unfinished child allowance and rejects negative costs', async (t) => {
  let attempts = 0;
  const f = setup(t, async (job) => ({
    output: attempts++ ? { candidates: [] } : { invalid: true },
    cost_usd: attempts === 1 ? 0.2 : job.max_cost_usd - job.cost,
  }));
  f.records(1);
  const plan = f.plan();
  // A caller may lower its total allowance to the already allocated child cap.
  plan.budget_total = plan.execution.max_cost_usd!;
  const first = f.continuation.start(scope, 'alice', plan, 'run');
  assert.throws(
    () => f.continuation.assertCanExecute({ ...first, cost: -0.1 }),
    code('budget_exceeded'),
  );
  await f.jobs.drain();
  assert.equal(f.jobs.get(scope, first.job_id).status, 'failed');
  f.jobs.retry(scope, first.job_id);
  await f.jobs.drain();
  f.continuation.advance();
  assert.equal(f.delivered.length, 2);
  assert.equal(f.continuation.status(first)!.status, 'completed');
  assert.ok(Math.abs(f.continuation.status(first)!.cost_usd - plan.budget_total) < 1e-9);
});
