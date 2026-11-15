import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationAnalysisService } from '../src/analysis.js';
import { ConversationReviewService } from '../src/refine.js';
import { LearningContinuationService } from '../src/learning-continuation.js';
import { LearningService } from '../src/learning.js';
import { JobService, ExecutorPreflightError, type ExecutorResult, type Job } from '../src/jobs.js';
import { CuratorError } from '../src/errors.js';
import { defaults } from '../src/settings.js';
import { fixture, scope, code } from './helpers.js';

function services(t: TestContext, behavior: (job: Job) => Promise<ExecutorResult>) {
  const { core } = fixture(t, {}, { productionDefaults: true });
  const settings = structuredClone(defaults);
  settings.limits = { daily_cost_usd: null, max_job_cost_usd: null, max_context_tokens: 45000 };
  const learning = new LearningService(core.store, () => settings);
  const review = new ConversationReviewService(core.store, learning, core.catalog, () => settings);
  let analysis: ConversationAnalysisService;
  let continuation: LearningContinuationService;
  const jobs = new JobService(
    core.store,
    () => settings,
    (job, output) => {
      if (job.payload.analysis_id) return analysis.acceptResult(job, output);
      learning.acceptResult(scope, 'alice', output, job.source_refs, job.payload);
      learning.markProcessedExact(scope, job.payload.session_ids as string[]);
      return [];
    },
    {
      direct: async ({ job }) => {
        try {
          if (job.payload.analysis_id) analysis.buildPayload(job);
          else {
            continuation.assertCanExecute(job);
            learning.materialize(scope, job.payload, false, job.execution);
          }
        } catch (error) {
          if (error instanceof CuratorError) throw new ExecutorPreflightError(error);
          throw error;
        }
        return behavior(job);
      },
    },
  );
  analysis = new ConversationAnalysisService(core.store, learning, review, jobs, () => settings);
  continuation = new LearningContinuationService(core.store, learning, jobs, () => settings);
  return { core, settings, learning, review, jobs, analysis, continuation };
}

test('multipart analysis completes without monetary caps while retaining finite context limits', async (t) => {
  const quote = 'The bounded integration check passed.';
  let deliveries = 0;
  const f = services(t, async (job) => {
    const context = f.analysis.buildPayload(job);
    assert.equal(Number.isFinite(context.result_char_limit), true);
    assert.equal(JSON.parse(JSON.stringify(context)).result_char_limit, context.result_char_limit);
    assert.equal(job.max_cost_usd, null);
    assert.equal(job.execution.max_cost_usd, undefined);
    deliveries++;
    return {
      output:
        job.payload.analysis_phase === 'extract'
          ? {
              candidates: [],
              observations: Array.from({ length: 1 }, () => ({
                text: 'Observed verified outcome.',
                evidence: [quote],
                source_refs: job.source_refs,
              })),
            }
          : { candidates: [] },
      ...(deliveries === 1 ? { cost_known: false } : { cost_usd: 0.002 }),
    };
  });
  f.settings.limits.max_context_tokens = 8000;
  const prepared = f.review.prepare(scope, 'large-history', (quote + '\n').repeat(1500));
  assert.ok(prepared.parts.length > 1);
  const parent = f.analysis.start(scope, 'alice', prepared, { mode: 'direct' }, 'unlimited');
  for (let step = 0; step < 64 && f.jobs.get(scope, parent.job_id).status !== 'completed'; step++) {
    await f.jobs.drain();
    f.analysis.advance();
  }
  const done = f.jobs.get(scope, parent.job_id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  const status = f.analysis.status(done)!;
  assert.equal(status.budget_total, null);
  assert.equal(status.cost_known, false);
  assert.equal(status.cost_usd, (deliveries - 1) * 0.002);
  assert.equal(Number.isFinite(status.cost_usd), true);
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
  assert.ok(f.learning.sessions(scope).every((record) => record.processed));
});

test('unlimited learning batches preserve known costs and continue after an unreported charge', async (t) => {
  let deliveries = 0;
  const f = services(t, async (job) => {
    assert.equal(job.max_cost_usd, null);
    return {
      output: { candidates: [] },
      ...(deliveries++ === 0 ? { cost_known: false } : { cost_usd: 0.01 }),
    };
  });
  f.settings.limits.max_context_tokens = 6000;
  for (let index = 0; index < 2; index++)
    f.learning.ingest(scope, 'alice', {
      source_instance: 'verified-import',
      session_id: 'verified-' + index,
      stage_id: 'passed',
      content: 'Observed check ' + index + '\n' + 'x'.repeat(6000),
      verified: true,
    });
  const plan = f.continuation.plan(scope, undefined, false, { mode: 'direct' }, 'unlimited');
  assert.equal(plan.batches.length, 2);
  assert.equal(plan.budget_total, null);
  assert.equal(plan.execution.max_cost_usd, undefined);
  const parent = f.continuation.start(scope, 'alice', plan, 'unlimited');
  await f.jobs.drain();
  assert.equal(f.continuation.advance(), 1);
  await f.jobs.drain();
  f.continuation.advance();
  const status = f.continuation.status(parent)!;
  assert.equal(status.status, 'completed');
  assert.equal(status.cost_known, false);
  assert.equal(status.cost_usd, 0.01);
  assert.equal(status.budget_total, null);
  assert.equal(status.records_processed, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
});

test('disabling monetary caps retains the configured context budget and reports oversized records', async (t) => {
  const f = services(t, async () => ({ output: { candidates: [] }, cost_usd: 0.25 }));
  assert.equal(f.settings.limits.max_context_tokens, 45000);
  const oversized = f.learning.ingest(scope, 'alice', {
    source_instance: 'verified-import',
    session_id: 'large-record',
    stage_id: 'passed',
    content: 'Full retained record\n' + 'x'.repeat(180000),
    verified: true,
  })!;
  const included = f.learning.ingest(scope, 'alice', {
    source_instance: 'verified-import',
    session_id: 'small-record',
    stage_id: 'passed',
    content: 'The bounded integration check passed.',
    verified: true,
  })!;
  const plan = f.continuation.plan(scope, undefined, false, { mode: 'direct' }, 'large');
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.payload.session_ids, [included.id]);
  assert.deepEqual(plan.skipped, [
    { record_id: oversized.id, reason: 'record_exceeds_context_limit' },
  ]);
  const parent = f.continuation.start(scope, 'alice', plan, 'large');
  await f.jobs.drain();
  f.continuation.advance();
  assert.equal(f.continuation.status(parent)!.status, 'completed');
  assert.equal(f.continuation.status(parent)!.cost_known, true);
  assert.equal(f.continuation.status(parent)!.cost_usd, 0.25);
  assert.equal(
    f.learning.sessions(scope).find((record) => record.id === oversized.id)!.processed,
    false,
  );
});

test('explicit finite and zero run allowances remain effective with unlimited defaults', async (t) => {
  const f = services(t, async () => ({ output: { candidates: [] }, cost_usd: 0.01 }));
  f.learning.ingest(scope, 'alice', {
    source_instance: 'verified-import',
    session_id: 'finite',
    stage_id: 'passed',
    content: 'The bounded integration check passed.',
    verified: true,
  });
  const plan = f.continuation.plan(
    scope,
    undefined,
    false,
    { mode: 'direct', max_cost_usd: 0.12 },
    'finite',
  );
  assert.equal(plan.budget_total, 0.12);
  assert.equal(plan.execution.max_cost_usd, 0.06);
  const parent = f.continuation.start(scope, 'alice', plan, 'finite');
  assert.equal(parent.max_cost_usd, 0.06);
  await f.jobs.drain();
  f.continuation.advance();
  assert.equal(f.continuation.status(parent)!.budget_total, 0.12);
  const zero = f.continuation.plan(
    scope,
    ['finite'],
    false,
    { mode: 'direct', max_cost_usd: 0 },
    'zero',
  );
  assert.equal(zero.budget_total, 0);
  assert.throws(() => f.continuation.start(scope, 'alice', zero, 'zero'), code('budget_exceeded'));

  f.settings.limits.max_context_tokens = 8000;
  const prepared = f.review.prepare(scope, 'history', 'The check passed.\n'.repeat(4000));
  assert.ok(prepared.parts.length > 1);
  assert.throws(
    () =>
      f.analysis.start(
        scope,
        'alice',
        prepared,
        { mode: 'direct', max_cost_usd: 0 },
        'zero-analysis',
      ),
    code('budget_exceeded'),
  );
  f.settings.analysis.max_calls = 1;
  assert.throws(
    () => f.analysis.start(scope, 'alice', prepared, { mode: 'direct' }, 'call-cap'),
    code('budget_exceeded'),
  );
});

test('a finite run retains an unknown previous charge when checking and delivering a retry', async (t) => {
  let deliveries = 0;
  const f = services(t, async () => {
    deliveries++;
    return { output: { invalid: true }, cost_usd: 0.01 };
  });
  f.learning.ingest(scope, 'alice', {
    source_instance: 'verified-import',
    session_id: 'partial-accounting',
    stage_id: 'passed',
    content: 'The bounded integration check passed.',
    verified: true,
  });
  const plan = f.continuation.plan(
    scope,
    undefined,
    false,
    { mode: 'direct', max_cost_usd: 0.12 },
    'retained',
  );
  plan.budget_total = plan.execution.max_cost_usd!;
  const first = f.continuation.start(scope, 'alice', plan, 'retained');
  await f.jobs.drain();
  const failed = f.jobs.get(scope, first.job_id);
  assert.equal(failed.status, 'failed');
  assert.equal(deliveries, 1);

  // Restore a durable partial-accounting state: the known portion is already
  // charged, while the previous attempt still holds its unknown remainder.
  const attempt = f.core.store.get<{ reserved: number; cost_known: boolean }>(
    'job_attempts',
    failed.attempt_id!,
  )!;
  attempt.reserved = failed.max_cost_usd! - failed.cost;
  attempt.cost_known = false;
  f.core.store.put('job_attempts', failed.attempt_id!, attempt);
  failed.cost_known = false;
  f.core.store.put('jobs', failed.job_id, failed);
  assert.throws(
    () => f.continuation.assertCanExecute({ ...failed, status: 'queued' }),
    code('budget_exceeded'),
  );

  f.jobs.retry(scope, failed.job_id);
  await f.jobs.drain();
  const refused = f.jobs.get(scope, failed.job_id);
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error?.code, 'budget_exceeded');
  assert.equal(deliveries, 1, 'the retry is rejected before provider delivery');
  assert.equal(refused.cost, 0.01);
  assert.equal(refused.cost_known, false);
  assert.equal(
    f.core.store.get<{ reserved: number }>('job_attempts', failed.attempt_id!)!.reserved,
    failed.max_cost_usd! - failed.cost,
  );
  assert.equal(
    f.core.store.get<{ reserved: number }>('job_attempts', refused.attempt_id!)!.reserved,
    0,
  );
});
