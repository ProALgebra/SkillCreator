import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuratorError, ensure } from '../src/errors.js';
import { ExecutorPreflightError, type Job } from '../src/jobs.js';
import type { Skill } from '../src/types.js';
import { fixture, pack, scope, code } from './helpers.js';

test('a preflight revision conflict releases its budget and allows the next job', async (t) => {
  let providerCalls = 0;
  let fallbackCalls = 0;
  const { core, call } = fixture(t, {
    executors: {
      direct: async ({ job }) => {
        // Materialization happens after queueing: a user can edit the source meanwhile.
        try {
          for (const id of job.payload.skill_ids as string[]) {
            const revision = (job.payload.revisions as Record<string, number>)[id];
            ensure(
              core.catalog.get(job, id).revision === revision,
              'revision_conflict',
              'Source changed before provider dispatch. api_key=preflight-test-only-secret',
            );
          }
        } catch (error) {
          if (error instanceof CuratorError) throw new ExecutorPreflightError(error);
          throw error;
        }
        providerCalls++;
        return { output: { updates: [] }, cost_usd: 0.25 };
      },
      session: async () => {
        fallbackCalls++;
        return { output: { updates: [] }, cost_usd: 0 };
      },
    },
  });
  await call('settings.patch', {
    expected_revision: 0,
    patch: { limits: { daily_cost_usd: 1 } },
  });
  const skill = (await call('skills.create', { files: pack('preflight-source') })) as Skill;
  const stale = (await call('curator.review', {
    skill_ids: [skill.skill_id],
    execution: { mode: 'auto' },
  })) as Job;
  await call('skills.update', {
    skill_id: skill.skill_id,
    expected_revision: skill.revision,
    files: pack('preflight-source', 'An updated, verified procedure.'),
  });
  await assert.rejects(
    call('curator.review', {
      skill_ids: [skill.skill_id],
      execution: { mode: 'direct' },
    }),
    code('budget_exceeded'),
  );
  await core.tick();
  const next = (await call('curator.review', {
    skill_ids: [skill.skill_id],
    execution: { mode: 'direct' },
  })) as Job;
  await core.tick();

  const failed = core.jobs.get(scope, stale.job_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.cost, 0);
  assert.deepEqual(failed.error, {
    code: 'revision_conflict',
    message: 'Source changed before provider dispatch. api_key=[REDACTED_SECRET]',
  });
  assert.equal(core.jobs.get(scope, next.job_id).status, 'completed');
  assert.equal(core.jobs.get(scope, next.job_id).cost, 0.25);
  assert.equal(providerCalls, 1, 'preflight validation did not dispatch model work');
  assert.equal(fallbackCalls, 0, 'a source conflict must not try another executor');
  assert.equal(core.jobs.status(scope).unknown, 0);
  const attempts = core.store.all<{ job_id: string; reserved: number; cost: number }>(
    'job_attempts',
  );
  assert.equal(
    attempts.reduce((sum, attempt) => sum + attempt.reserved, 0),
    0,
  );
  assert.equal(attempts.find((attempt) => attempt.job_id === stale.job_id)?.cost, 0);
  const failures = core.store
    .all<{ type: string; entity_id: string; details: Record<string, unknown> }>('events')
    .filter((event) => event.type === 'job.failed' && event.entity_id === stale.job_id);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.details.code, 'revision_conflict');
});

test('a generic CuratorError or preflight lookalike retains the uncertain reservation', async (t) => {
  for (const failure of [
    new CuratorError('revision_conflict', 'Provider work may already have begun'),
    {
      name: 'ExecutorPreflightError',
      code: 'revision_conflict',
      message: 'An untrusted error cannot certify that no provider was called',
    },
    new Error('The connection closed after provider dispatch'),
  ]) {
    let dispatchCalls = 0;
    const { core, call } = fixture(t, {
      executors: {
        direct: async () => {
          dispatchCalls++;
          throw failure;
        },
      },
    });
    const first = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
    const next = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
    await core.tick();
    assert.equal(core.jobs.get(scope, first.job_id).status, 'unknown_outcome');
    assert.equal(core.jobs.get(scope, next.job_id).status, 'queued');
    assert.equal(dispatchCalls, 1);
    const attempts = core.store.all<{ reserved: number }>('job_attempts');
    assert.equal(
      attempts.reduce((sum, attempt) => sum + attempt.reserved, 0),
      first.max_cost_usd,
    );
  }
});
