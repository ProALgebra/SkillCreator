import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, pack, owner, scope, code } from './helpers.js';
import { tables } from '../src/store.js';
import { hash } from '../src/security.js';
import type { Job, Executor } from '../src/jobs.js';
import type { Principal, Proposal, Skill } from '../src/types.js';

const keepAll: Executor = async ({ job }) => ({
  output: {
    actions: (job.payload.skill_ids as string[]).map((skill_id) => ({
      action: 'keep',
      skill_ids: [skill_id],
      rationale: 'The distinct procedure remains useful.',
    })),
  },
  cost_usd: 0,
});
type Optimization = {
  run_id: string;
  jobs: Job[];
  skipped: Array<{ skill_id: string; reason: string }>;
  total: number;
  next_cursor: number | null;
};
type Preview = Omit<Optimization, 'run_id' | 'jobs'> & {
  batches: Array<{ skill_ids: string[] }>;
};
const snapshot = (core: ReturnType<typeof fixture>['core']) =>
  Object.fromEntries(tables.map((table) => [table, core.store.all(table)]));

test('optimizer dry run preserves every table and the existing durable cursor', async (t) => {
  const { call, core } = fixture(t, { executors: { direct: keepAll } });
  for (const name of ['alpha', 'beta', 'gamma']) await call('skills.create', { files: pack(name) });
  await call('settings.patch', {
    expected_revision: 0,
    patch: { curator: { max_batch_skills: 2, max_batches_per_run: 1 } },
  });
  const cursorKey = 'optimizer-cursor:' + hash(scope);
  core.store.put('control', cursorKey, { catalog_hash: 'stale-catalog', cursor: 2 });
  const before = snapshot(core);
  const changesBefore = core.store.db.prepare('SELECT total_changes() AS count').get();
  const plan = (await core.call(
    'curator.optimize',
    {
      dry_run: true,
      execution: { mode: 'direct' },
      idempotency_key: 'preview-must-not-persist',
    },
    owner,
  )) as Preview;
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0]!.skill_ids.length, 2);
  assert.equal(plan.next_cursor, 2, 'A stale persisted catalog cursor restarts the preview');
  assert.deepEqual(snapshot(core), before);
  assert.deepEqual(core.store.db.prepare('SELECT total_changes() AS count').get(), changesBefore);
  assert.deepEqual(core.store.get('control', cursorKey), {
    catalog_hash: 'stale-catalog',
    cursor: 2,
  });
});

test('optimizer run replay queues once and a second pending pass is rejected', async (t) => {
  const { call, core } = fixture(t, { executors: { direct: keepAll } });
  await call('skills.create', { files: pack('replay') });
  const input = { idempotency_key: 'optimization-once', execution: { mode: 'direct' as const } };
  const [first, replay] = (await Promise.all([
    call('curator.optimize', input),
    call('curator.optimize', input),
  ])) as [Optimization, Optimization];
  assert.deepEqual(replay, first);
  assert.equal(first.jobs.length, 1);
  assert.equal(core.jobs.list(scope).filter((j) => j.operation === 'optimize').length, 1);
  await assert.rejects(
    call('curator.optimize', { execution: { mode: 'direct' } }),
    code('rate_limited'),
  );
  assert.equal(core.jobs.list(scope).length, 1);
  await core.tick();
  assert.equal(core.jobs.get(scope, first.jobs[0]!.job_id).status, 'completed');
  assert.deepEqual(await call('curator.optimize', input), first);
  const status = (await call('curator.status')) as {
    jobs: Job[];
    reports: Array<{ actions: unknown[] }>;
  };
  assert.equal(status.jobs.length, 1);
  assert.equal(status.reports[0]!.actions.length, 1);
});

test('bounded optimizer passes cover the library through the cursor and report oversized packages', async (t) => {
  const { call, core } = fixture(t, { executors: { direct: keepAll } });
  const small: Skill[] = [];
  for (let index = 0; index < 7; index++)
    small.push((await call('skills.create', { files: pack('paged-' + index) })) as Skill);
  const oversized = (await call('skills.create', {
    files: pack('zz-oversized', 'Preserve this lengthy instruction. '.repeat(1200)),
  })) as Skill;
  await call('settings.patch', {
    expected_revision: 0,
    patch: {
      curator: { max_batch_skills: 2, max_batches_per_run: 1 },
      limits: { max_context_tokens: 4000 },
    },
  });
  const seen: string[] = [];
  const skipped: Optimization['skipped'] = [];
  let next: number | null = 0;
  let runs = 0;
  while (next !== null && runs < 10) {
    const result = (await call('curator.optimize', {
      execution: { mode: 'direct', max_cost_usd: 0.01 },
    })) as Optimization;
    assert.equal(result.total, 8);
    assert.ok(result.jobs.length <= 1);
    for (const job of result.jobs) {
      const ids = job.payload.skill_ids as string[];
      assert.ok(ids.length <= 2);
      seen.push(...ids);
    }
    skipped.push(...result.skipped);
    next = result.next_cursor;
    runs++;
    await core.tick();
    for (const job of result.jobs)
      assert.equal(core.jobs.get(scope, job.job_id).status, 'completed');
  }
  assert.equal(next, null, 'The cursor reaches the end within bounded passes');
  assert.equal(runs, 4);
  assert.equal(new Set(seen).size, seen.length, 'No source is queued twice within a pass');
  assert.deepEqual([...seen].sort(), small.map((s) => s.skill_id).sort());
  assert.deepEqual(skipped, [
    { skill_id: oversized.skill_id, reason: 'package_exceeds_context_limit' },
  ]);
  assert.equal(
    core.store.get<{ cursor: number }>('control', 'optimizer-cursor:' + hash(scope))!.cursor,
    0,
  );
  const onlyOversized = (await call('curator.optimize', {
    dry_run: true,
    skill_ids: [oversized.skill_id],
  })) as Preview;
  assert.equal(onlyOversized.batches.length, 0);
  assert.deepEqual(onlyOversized.skipped, skipped);
});

test('optimizer and rollback require curator authority and reject a forged scope', async (t) => {
  const { call } = fixture(t, { executors: { direct: keepAll } });
  const skill = (await call('skills.create', { files: pack('permission') })) as Skill;
  for (const role of ['viewer', 'editor', 'worker'] as const) {
    const principal: Principal = { ...owner, roles: [role] };
    await assert.rejects(
      call('curator.optimize', { skill_ids: [skill.skill_id] }, principal),
      code('forbidden'),
    );
    await assert.rejects(
      call('curator.rollback', { proposal_id: 'unknown', expected_revision: 1 }, principal),
      code('forbidden'),
    );
  }
  const curator: Principal = { ...owner, subject: 'trusted-curator', roles: ['curator'] };
  const accepted = (await call(
    'curator.optimize',
    { skill_ids: [skill.skill_id] },
    curator,
  )) as Optimization;
  assert.equal(accepted.jobs.length, 1);
  assert.equal(accepted.jobs[0]!.requested_by, curator.subject);
  for (const method of ['curator.status', 'curator.optimize', 'curator.rollback'] as const)
    for (const foreignScope of [{ tenant_id: 'tenant-b' }, { workspace_id: 'workspace-b' }])
      await assert.rejects(call(method, { scope: foreignScope }), code('scope_violation'));
});

test('curator pause, global pause and global disable prevent manual optimizer work', async (t) => {
  const { call, core } = fixture(t, { executors: { direct: keepAll } });
  await call('skills.create', { files: pack('pausable') });
  for (const subsystem of ['curator', 'all'] as const) {
    await call('system.pause', { subsystem });
    await assert.rejects(call('curator.optimize'), code('executor_unavailable'));
    assert.equal(core.jobs.list(scope).length, 0);
    await call('system.resume', { subsystem });
  }
  await call('settings.patch', { expected_revision: 0, patch: { enabled: false } });
  await assert.rejects(call('curator.optimize'), code('executor_unavailable'));
  assert.equal(core.jobs.list(scope).length, 0);
  await call('settings.patch', { expected_revision: 1, patch: { enabled: true } });
  assert.equal(((await call('curator.optimize')) as Optimization).jobs.length, 1);
});

test('rollback RPC rejects an obsolete revision and non-optimizer changes', async (t) => {
  const { call, core } = fixture(t);
  const skill = (await call('skills.create', { files: pack('ordinary') })) as Skill;
  const proposed = core.catalog.proposal(
    scope,
    owner.subject,
    'patch',
    [
      {
        action: 'update',
        skill_id: skill.skill_id,
        expected_revision: skill.revision,
        files: pack('ordinary', 'A manually reviewed improvement.'),
      },
    ],
    'Ordinary review proposal',
  );
  const approved = (await call('proposals.approve', {
    proposal_id: proposed.proposal_id,
    expected_revision: proposed.revision,
  })) as Proposal;
  await call('proposals.apply', {
    proposal_id: approved.proposal_id,
    expected_revision: approved.revision,
  });
  const applied = core.catalog.getProposal(scope, proposed.proposal_id);
  assert.equal(applied.status, 'applied');
  await assert.rejects(
    call('curator.rollback', {
      proposal_id: applied.proposal_id,
      expected_revision: proposed.revision,
    }),
    code('revision_conflict'),
  );
  const curator: Principal = { ...owner, roles: ['curator'] };
  await assert.rejects(
    call(
      'curator.rollback',
      {
        proposal_id: applied.proposal_id,
        expected_revision: applied.revision,
      },
      curator,
    ),
    code('not_found'),
  );
  assert.equal(core.store.all('proposals').length, 1);
  assert.equal(core.catalog.get(scope, skill.skill_id).revision, 2);
});

test('optimizer status exposes only the authenticated workspace reports and jobs', async (t) => {
  const { call, core } = fixture(t, { executors: { direct: keepAll } });
  const foreign: Principal = {
    ...owner,
    subject: 'foreign-owner',
    tenant_id: 'tenant-b',
    workspace_ids: [scope.workspace_id],
  };
  const neighbor: Principal = {
    ...owner,
    subject: 'neighbor-owner',
    workspace_ids: ['workspace-b'],
  };
  await call('skills.create', { files: pack('local-library') });
  await call('skills.create', { files: pack('foreign-confidential-library') }, foreign);
  await call('skills.create', { files: pack('neighbor-confidential-library') }, neighbor);
  const localRun = (await call('curator.optimize')) as Optimization;
  const foreignRun = (await call('curator.optimize', {}, foreign)) as Optimization;
  const neighborRun = (await call('curator.optimize', {}, neighbor)) as Optimization;
  await core.tick();
  const localStatus = (await call('curator.status')) as {
    jobs: Job[];
    reports: Array<{ job_id: string }>;
  };
  assert.deepEqual(
    localStatus.jobs.map((j) => j.job_id),
    localRun.jobs.map((j) => j.job_id),
  );
  assert.deepEqual(
    localStatus.reports.map((r) => r.job_id),
    localRun.jobs.map((j) => j.job_id),
  );
  assert.equal(JSON.stringify(localStatus).includes(foreignRun.jobs[0]!.job_id), false);
  assert.equal(JSON.stringify(localStatus).includes(neighborRun.jobs[0]!.job_id), false);
  assert.equal(JSON.stringify(localStatus).includes('foreign-confidential-library'), false);
  const foreignStatus = (await call('curator.status', {}, foreign)) as {
    jobs: Job[];
    reports: Array<{ job_id: string }>;
  };
  assert.deepEqual(
    foreignStatus.jobs.map((j) => j.job_id),
    foreignRun.jobs.map((j) => j.job_id),
  );
  assert.deepEqual(
    foreignStatus.reports.map((r) => r.job_id),
    foreignRun.jobs.map((j) => j.job_id),
  );
  assert.equal(JSON.stringify(foreignStatus).includes(localRun.jobs[0]!.job_id), false);
  const neighborStatus = (await call('curator.status', {}, neighbor)) as {
    jobs: Job[];
    reports: Array<{ job_id: string }>;
  };
  assert.deepEqual(
    neighborStatus.jobs.map((j) => j.job_id),
    neighborRun.jobs.map((j) => j.job_id),
  );
  assert.deepEqual(
    neighborStatus.reports.map((r) => r.job_id),
    neighborRun.jobs.map((j) => j.job_id),
  );
  assert.equal(JSON.stringify(neighborStatus).includes(localRun.jobs[0]!.job_id), false);
  assert.equal(JSON.stringify(neighborStatus).includes(foreignRun.jobs[0]!.job_id), false);
});
