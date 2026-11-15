import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CuratorCore } from '../src/core.js';
import type { Job } from '../src/jobs.js';
import { contextCharLimit } from '../src/context.js';
import { fixture, scope, code } from './helpers.js';

interface Progress {
  job_id: string;
  status: string;
  analysis: {
    status: string;
    batches_completed: number;
    batches_total: number;
    records_processed: number;
    records_total: number;
    cost_usd: number;
    budget_total: number;
    calls_used: number;
  };
}

test('learning RPC and tick continue all verified records, expose aggregate progress and stop after completion', async (t) => {
  let core: CuratorCore;
  let firstID: string;
  let call: ReturnType<typeof fixture>['call'];
  const delivered: string[][] = [];
  const observed: Progress[] = [];
  const f = fixture(t, {
    executors: {
      direct: async ({ job }) => {
        const context = core.modelPayload(job) as {
          sessions: Array<{ record_id: string; content: string }>;
          source_refs: string[];
        };
        assert.equal(context.sessions.length, 1);
        assert.deepEqual(context.source_refs, job.source_refs);
        assert.ok(
          JSON.stringify(context).length <=
            contextCharLimit(core.settings.get(scope).settings, job.execution),
        );
        delivered.push(context.sessions.map((source) => source.record_id));
        observed.push((await call('jobs.progress', { job_id: firstID })) as Progress);
        return { output: { candidates: [] }, cost_usd: 0.001 };
      },
    },
  });
  core = f.core;
  call = f.call;
  await call('settings.patch', {
    expected_revision: 0,
    patch: { limits: { max_context_tokens: 8000 } },
  });
  for (let index = 0; index < 3; index++)
    await call('learning.ingest', {
      transcript: {
        source_instance: 'rpc-import',
        session_id: 'session-' + index,
        stage_id: 'done',
        content: 'Observed test result ' + index + '\n' + 'x'.repeat(12000),
        verified: true,
      },
    });
  const records = core.learning.sessions(scope);
  const first = (await call('learning.run', {
    execution: { mode: 'direct', max_cost_usd: 0.03 },
  })) as Job;
  firstID = first.job_id;
  assert.deepEqual(first.payload.session_ids, [records[0]!.id]);
  assert.deepEqual(
    (first.payload.learning_batch as { deferred_ids: string[] }).deferred_ids,
    records.slice(1).map((record) => record.id),
  );
  assert.equal(core.jobs.list(scope).length, 1);
  assert.equal(
    core.learning.sessions(scope).some((record) => record.processed),
    false,
  );
  const queued = (await call('jobs.progress', { job_id: firstID })) as Progress;
  assert.equal(queued.analysis.batches_total, 3);
  assert.equal(queued.analysis.records_processed, 0);

  await core.tick();
  assert.deepEqual(
    delivered.flat(),
    records.map((record) => record.id),
  );
  assert.deepEqual(
    observed.map((progress) => progress.analysis.batches_completed),
    [0, 1, 2],
  );
  assert.deepEqual(
    observed.map((progress) => progress.analysis.records_processed),
    [0, 1, 2],
  );
  const final = (await call('jobs.progress', { job_id: firstID })) as Progress;
  assert.equal(final.analysis.status, 'completed');
  assert.equal(final.analysis.batches_completed, 3);
  assert.equal(final.analysis.records_processed, 3);
  assert.equal(final.analysis.calls_used, 3);
  assert.equal(final.analysis.budget_total, 0.03);
  assert.ok(Math.abs(final.analysis.cost_usd - 0.003) < 1e-9);
  assert.equal(
    core.learning.sessions(scope).every((record) => record.processed),
    true,
  );
  assert.equal(core.jobs.list(scope).length, 3);
  for (const job of core.jobs.list(scope)) assert.equal(job.status, 'completed');
  await core.tick();
  await core.tick();
  assert.equal(core.jobs.list(scope).length, 3);
  assert.equal(delivered.length, 3);
});

test('zero-budget learning RPC refuses execution without creating a job or processing evidence', async (t) => {
  let calls = 0;
  const { core, call } = fixture(t, {
    executors: {
      direct: async () => {
        calls++;
        return { output: { candidates: [] }, cost_usd: 0 };
      },
    },
  });
  await call('learning.ingest', {
    transcript: {
      source_instance: 'rpc-import',
      session_id: 'zero-budget',
      stage_id: 'done',
      content: 'A verified test result.',
      verified: true,
    },
  });
  const preview = (await call('learning.run', {
    dry_run: true,
    execution: { mode: 'direct', max_cost_usd: 0 },
  })) as { batches_total: number };
  assert.equal(preview.batches_total, 1);
  await assert.rejects(
    call('learning.run', { execution: { mode: 'direct', max_cost_usd: 0 } }),
    code('budget_exceeded'),
  );
  await core.tick();
  assert.equal(calls, 0);
  assert.equal(core.jobs.list(scope).length, 0);
  assert.equal(core.learning.sessions(scope)[0]!.processed, false);
});
