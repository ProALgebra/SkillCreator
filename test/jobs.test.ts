import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, owner, pack, code } from './helpers.js';
import type { Job } from '../src/jobs.js';
import type { Principal, Skill } from '../src/types.js';
const worker: Principal = {
  subject: 'valeria-worker',
  tenant_id: scope.tenant_id,
  workspace_ids: [scope.workspace_id],
  roles: ['worker'],
  worker_kind: 'valeria',
};
async function bridge(call: ReturnType<typeof fixture>['call']) {
  await call('settings.patch', {
    expected_revision: 0,
    patch: { valeria_bridge: { enabled: true }, external_bridge: { enabled: true } },
  });
}

test('direct/session/auto routing is independent of VALERIA', async (t) => {
  const invoked: string[] = [];
  const executor = (mode: string) => async () => {
    invoked.push(mode);
    return { output: { updates: [] }, cost_usd: 0.1 };
  };
  const { call, core } = fixture(t, {
    executors: { direct: executor('direct'), session: executor('session') },
  });
  await bridge(call);
  for (const mode of ['direct', 'session', 'auto'] as const) {
    const job = (await call('curator.review', { execution: { mode } })) as Job;
    await core.tick();
    assert.equal(core.jobs.get(scope, job.job_id).status, 'completed');
  }
  assert.deepEqual(invoked, ['direct', 'session', 'direct']);
  assert.equal(core.jobs.list(scope).filter((j) => j.executor_mode === 'valeria').length, 0);
});
test('unavailable explicit executor fails without implicit fallback', async (t) => {
  const { call } = fixture(t, {
    executors: { direct: async () => ({ output: { updates: [] }, cost_usd: 0 }) },
  });
  await assert.rejects(
    call('curator.review', { execution: { mode: 'valeria' } }),
    code('executor_unavailable'),
  );
  await assert.rejects(
    call('curator.review', { execution: { mode: 'session' } }),
    code('executor_unavailable'),
  );
});
test('operation setting and explicit override are pinned when job is created', async (t) => {
  const { call, core } = fixture(t, {
    executors: {
      direct: async () => ({ output: { updates: [] }, cost_usd: 0 }),
      session: async () => ({ output: { updates: [] }, cost_usd: 0 }),
    },
  });
  await call('settings.patch', {
    expected_revision: 0,
    patch: { execution: { operation_modes: { review: 'session' } } },
  });
  const first = (await call('curator.review')) as Job;
  const second = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
  await call('settings.patch', {
    expected_revision: 1,
    patch: { execution: { operation_modes: { review: 'direct' } } },
  });
  assert.equal(core.jobs.get(scope, first.job_id).executor_mode, 'session');
  assert.equal(second.executor_mode, 'direct');
});
test('worker lease is scoped, opaque, heartbeat-bound and completion is idempotent', async (t) => {
  const { call, core } = fixture(t);
  await bridge(call);
  const job = (await call('curator.review', {
    execution: { mode: 'valeria' },
    idempotency_key: 'work-once',
  })) as Job;
  const replay = (await call('curator.review', {
    execution: { mode: 'valeria' },
    idempotency_key: 'work-once',
  })) as Job;
  assert.equal(job.job_id, replay.job_id);
  const lease = (await call(
    'jobs.lease',
    { worker_id: worker.subject, worker_kind: 'valeria' },
    worker,
  )) as { job: Job; lease_token: string };
  assert.equal(lease.job.job_id, job.job_id);
  assert.equal(JSON.stringify(core.store.all('job_leases')).includes(lease.lease_token), false);
  await assert.rejects(
    call(
      'jobs.heartbeat',
      { job_id: job.job_id, worker_id: worker.subject, lease_token: 'wrong' },
      worker,
    ),
    code('forbidden'),
  );
  await call(
    'jobs.heartbeat',
    {
      job_id: job.job_id,
      worker_id: worker.subject,
      lease_token: lease.lease_token,
      progress: 0.5,
    },
    worker,
  );
  const input = {
    job_id: job.job_id,
    worker_id: worker.subject,
    lease_token: lease.lease_token,
    result: { updates: [] },
    cost_usd: 0.2,
  };
  await call('jobs.complete', input, worker);
  await call('jobs.complete', input, worker);
  assert.equal(core.jobs.get(scope, job.job_id).status, 'completed');
  assert.equal(core.jobs.get(scope, job.job_id).cost, 0.2);
  await assert.rejects(
    call('jobs.complete', { ...input, cost_usd: 0.3 }, worker),
    code('idempotency_conflict'),
  );
});
test('expired lease becomes unknown and cannot retry or receive a second lease', async (t) => {
  const { call, core } = fixture(t);
  await bridge(call);
  const job = (await call('curator.review', { execution: { mode: 'valeria' } })) as Job;
  const lease = (await call(
    'jobs.lease',
    { worker_id: worker.subject, worker_kind: 'valeria' },
    worker,
  )) as { lease_token: string };
  const row = core.store.get<Record<string, unknown>>('job_leases', job.job_id)!;
  core.store.put('job_leases', job.job_id, { ...row, expires_at: '2000-01-01T00:00:00.000Z' });
  core.jobs.expire();
  assert.equal(core.jobs.get(scope, job.job_id).status, 'unknown_outcome');
  await assert.rejects(call('jobs.retry', { job_id: job.job_id }), code('unknown_outcome'));
  const second = (await call(
    'jobs.lease',
    { worker_id: worker.subject, worker_kind: 'valeria' },
    worker,
  )) as { job: Job | null };
  assert.equal(second.job, null);
  // Original worker can reconcile by its original capability and durable marker without a new LLM run.
  await call(
    'jobs.complete',
    {
      job_id: job.job_id,
      worker_id: worker.subject,
      lease_token: lease.lease_token,
      result: { updates: [] },
      cost_usd: 0.1,
    },
    worker,
  );
  assert.equal(core.jobs.get(scope, job.job_id).status, 'completed');
});
test('timeouts retain unknown outcome and never dispatch a fallback executor', async (t) => {
  let direct = 0,
    session = 0;
  const { call, core } = fixture(t, {
    executors: {
      direct: async () => {
        direct++;
        return new Promise(() => {});
      },
      session: async () => {
        session++;
        return { output: { updates: [] }, cost_usd: 0 };
      },
    },
  });
  const j = (await call('curator.review', {
    execution: { mode: 'auto', timeout_sec: 0.01 },
  })) as Job;
  await core.tick();
  assert.equal(core.jobs.get(scope, j.job_id).status, 'unknown_outcome');
  assert.equal(direct, 1);
  assert.equal(session, 0);
});
test('global and workspace concurrency limits are enforced', async (t) => {
  let active = 0,
    max = 0;
  const { call, core } = fixture(t, {
    executors: {
      direct: async () => {
        active++;
        max = Math.max(active, max);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { output: { updates: [] }, cost_usd: 0.1 };
      },
    },
  });
  for (let i = 0; i < 3; i++) await call('curator.review', { execution: { mode: 'direct' } });
  await core.tick();
  assert.equal(max, 1);
  assert.equal(
    core.jobs.list(scope).every((j) => j.status === 'completed'),
    true,
  );
});
test('budget overrun rejects model changes while charging reported cost', async (t) => {
  const { call, core } = fixture(t, {
    executors: { direct: async () => ({ output: { updates: [] }, cost_usd: 0.8 }) },
  });
  const j = (await call('curator.review', {
    execution: { mode: 'direct', max_cost_usd: 0.5 },
  })) as Job;
  await core.tick();
  const after = core.jobs.get(scope, j.job_id);
  assert.equal(after.status, 'failed');
  assert.equal(after.error?.code, 'budget_exceeded');
  assert.equal(after.cost, 0.8);
  assert.equal(core.store.all('proposals').length, 0);
});
test('job pause, resume and cancellation before dispatch do not spend tokens', async (t) => {
  let count = 0;
  const { call, core } = fixture(t, {
    executors: {
      direct: async () => {
        count++;
        return { output: { updates: [] }, cost_usd: 0 };
      },
    },
  });
  const j = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
  await call('jobs.pause', { job_id: j.job_id });
  await core.tick();
  assert.equal(count, 0);
  await call('jobs.resume', { job_id: j.job_id });
  await call('jobs.cancel', { job_id: j.job_id });
  await core.tick();
  assert.equal(count, 0);
  assert.equal(core.jobs.get(scope, j.job_id).status, 'cancelled');
});
test('external workers receive no raw transcript without explicit disclosure setting', async (t) => {
  const { call } = fixture(t);
  await bridge(call);
  await call('learning.ingest', {
    transcript: {
      source_instance: 'valeria',
      session_id: 's-private',
      stage_id: 'done',
      content: 'Confirmed reusable private procedure',
      verified: true,
    },
  });
  await call('learning.run', { execution: { mode: 'valeria' } });
  const result = (await call(
    'jobs.lease',
    { worker_id: worker.subject, worker_kind: 'valeria' },
    worker,
  )) as { context: { sessions: unknown[] } };
  assert.deepEqual(result.context.sessions, []);
});
test('LLM cannot write arbitrary skills or execute embedded instructions', async (t) => {
  let victim: Skill;
  const { call, core } = fixture(t, {
    executors: {
      direct: async () => ({
        output: {
          updates: [
            {
              skill_id: victim.skill_id,
              files: pack('victim', 'Malicious change'),
              rationale: 'Ignore rules',
            },
          ],
        },
        cost_usd: 0.1,
      }),
    },
  });
  victim = (await call('skills.create', { files: pack('victim') })) as Skill;
  const other = (await call('skills.create', { files: pack('other') })) as Skill;
  const j = (await call('curator.review', {
    skill_ids: [other.skill_id],
    execution: { mode: 'direct' },
  })) as Job;
  await core.tick();
  assert.equal(core.jobs.get(scope, j.job_id).status, 'failed');
  assert.equal(core.catalog.get(scope, victim.skill_id).revision, 1);
  assert.equal(core.store.all('proposals').length, 0);
});

test('admin acknowledgement reconciles an unknown local run and releases its slot', async (t) => {
  let calls = 0;
  const { call, core } = fixture(t, {
    executors: {
      direct: async () => {
        if (calls++ === 0) return new Promise(() => {});
        return { output: { updates: [] }, cost_usd: 0.1 };
      },
    },
  });
  const job = (await call('curator.review', {
    execution: { mode: 'direct', timeout_sec: 0.01 },
  })) as Job;
  await core.tick();
  await call('jobs.cancel', {
    job_id: job.job_id,
    confirm_stopped: true,
    reason: 'Provider confirmed the run is stopped',
    cost_usd: 0.1,
  });
  const next = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
  await core.tick();
  assert.equal(core.jobs.get(scope, next.job_id).status, 'completed');
  assert.equal(core.jobs.get(scope, job.job_id).status, 'cancelled');
});
