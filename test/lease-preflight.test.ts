import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuratorError } from '../src/errors.js';
import { fixture, pack, scope, owner } from './helpers.js';

for (const kind of ['external', 'valeria'] as const)
  test(`${kind} lease rejects invalid context without an accepted attempt and leases the next job`, (t) => {
    const { core } = fixture(t);
    core.settings.patch(scope, owner.subject, { [kind + '_bridge']: { enabled: true } }, 0);
    const invalid = core.jobs.run(scope, owner.subject, 'review', {}, { mode: kind }, 'invalid');
    const valid = core.jobs.run(scope, owner.subject, 'review', {}, { mode: kind }, 'valid');
    const leased = core.jobs.lease(scope, kind, 'worker', (job) => {
      if (job.job_id === invalid.job_id)
        throw new CuratorError(
          'budget_exceeded',
          'Context too large. api_key=example-private-value',
        );
      return { job_id: job.job_id, materialized: true };
    });
    assert.equal(leased?.job.job_id, valid.job_id);
    assert.deepEqual(leased?.context, { job_id: valid.job_id, materialized: true });
    const failed = core.jobs.get(scope, invalid.job_id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempt, 0);
    assert.equal(failed.attempt_id, undefined);
    assert.equal(failed.cost, 0);
    assert.equal(failed.error?.message.includes('example-private-value'), false);
    assert.equal(core.store.get('job_leases', invalid.job_id), undefined);
    const attempts = core.store.all<{ job_id: string; reserved: number }>('job_attempts');
    assert.deepEqual(
      attempts.map((attempt) => attempt.job_id),
      [valid.job_id],
    );
    assert.equal(attempts[0]?.reserved, valid.max_cost_usd);
    assert.equal(core.jobs.status(scope).unknown, 0);
    assert.equal(core.jobs.remainingBudget(scope), 2);
  });

test('real oversized external context fails before lease acceptance and releases queued budget', (t) => {
  const { core } = fixture(t);
  core.settings.patch(
    scope,
    owner.subject,
    { external_bridge: { enabled: true }, limits: { max_context_tokens: 100 } },
    0,
  );
  const skill = core.catalog.create(
    scope,
    owner.subject,
    pack('large-context', 'Procedure. '.repeat(100)),
  );
  const job = core.jobs.run(
    scope,
    owner.subject,
    'review',
    { skill_ids: [skill.skill_id], revisions: { [skill.skill_id]: skill.revision } },
    { mode: 'external' },
    'large-context',
  );
  const leased = core.jobs.lease(scope, 'external', 'worker', (candidate) =>
    core.modelPayload(candidate, true),
  );
  assert.equal(leased, null);
  assert.equal(core.jobs.get(scope, job.job_id).status, 'failed');
  assert.equal(core.jobs.get(scope, job.job_id).error?.code, 'budget_exceeded');
  assert.equal(core.store.all('job_leases').length, 0);
  assert.equal(core.store.all('job_attempts').length, 0);
  assert.equal(core.jobs.remainingBudget(scope), 3);
});

test('unexpected preparation errors roll back earlier preflight rejections in the same claim', (t) => {
  const { core } = fixture(t);
  core.settings.patch(scope, owner.subject, { external_bridge: { enabled: true } }, 0);
  const jobs = ['invalid', 'unexpected'].map((marker) =>
    core.jobs.run(scope, owner.subject, 'review', {}, { mode: 'external' }, marker),
  );
  const beforeEvents = core.store.all('events').length;
  assert.throws(
    () =>
      core.jobs.lease(scope, 'external', 'worker', (job) => {
        if (job.job_id === jobs[0]!.job_id) throw new CuratorError('forbidden', 'Privacy changed');
        throw new Error('storage read failed');
      }),
    /storage read failed/,
  );
  for (const job of jobs) assert.equal(core.jobs.get(scope, job.job_id).status, 'waiting_executor');
  assert.equal(core.store.all('job_attempts').length, 0);
  assert.equal(core.store.all('job_leases').length, 0);
  assert.equal(core.store.all('events').length, beforeEvents);
});

test('lease write failure rolls back job acceptance and its reservation', (t) => {
  const { core } = fixture(t);
  core.settings.patch(scope, owner.subject, { external_bridge: { enabled: true } }, 0);
  const job = core.jobs.run(
    scope,
    owner.subject,
    'review',
    {},
    { mode: 'external' },
    'write-fails',
  );
  const put = core.store.put.bind(core.store);
  t.mock.method(core.store, 'put', (table, id, value) => {
    if (table === 'job_leases') throw new Error('lease storage failed');
    put(table, id, value);
  });
  assert.throws(
    () => core.jobs.lease(scope, 'external', 'worker', () => ({ prepared: true })),
    /lease storage failed/,
  );
  assert.equal(core.jobs.get(scope, job.job_id).status, 'waiting_executor');
  assert.equal(core.jobs.get(scope, job.job_id).attempt, 0);
  assert.equal(core.store.all('job_attempts').length, 0);
  assert.equal(core.store.all('job_leases').length, 0);
});

test('asynchronous preparation is rejected before acceptance', (t) => {
  const { core } = fixture(t);
  core.settings.patch(scope, owner.subject, { external_bridge: { enabled: true } }, 0);
  const job = core.jobs.run(scope, owner.subject, 'review', {}, { mode: 'external' }, 'async');
  assert.throws(
    () => core.jobs.lease(scope, 'external', 'worker', async () => ({ prepared: true })),
    /must be synchronous/,
  );
  assert.equal(core.jobs.get(scope, job.job_id).status, 'waiting_executor');
  assert.equal(core.store.all('job_attempts').length, 0);
  assert.equal(core.store.all('job_leases').length, 0);
});

test('a lost accepted lease response never makes the job available to another worker', (t) => {
  const { core } = fixture(t);
  core.settings.patch(scope, owner.subject, { external_bridge: { enabled: true } }, 0);
  const job = core.jobs.run(
    scope,
    owner.subject,
    'review',
    {},
    { mode: 'external' },
    'lost-response',
  );
  core.jobs.lease(scope, 'external', 'original-worker', () => ({ prepared: true }));
  assert.equal(core.jobs.lease(scope, 'external', 'another-worker'), null);
  const lease = core.store.get<Record<string, unknown>>('job_leases', job.job_id)!;
  core.store.put('job_leases', job.job_id, { ...lease, expires_at: '2000-01-01T00:00:00.000Z' });
  core.jobs.expire();
  assert.equal(core.jobs.get(scope, job.job_id).status, 'unknown_outcome');
  assert.equal(core.jobs.lease(scope, 'external', 'another-worker'), null);
  assert.equal(core.store.all<{ reserved: number }>('job_attempts')[0]?.reserved, 1);
});
