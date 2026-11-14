import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, pack, scope, code } from './helpers.js';
import type { Job } from '../src/jobs.js';
import type { Skill } from '../src/types.js';

const keep = async ({ job }: { job: Job }) => ({
  cost_usd: 0.01,
  output: {
    actions: (job.payload.skill_ids as string[]).map((id) => ({
      action: 'keep',
      skill_ids: [id],
      rationale: 'Keep this distinct procedure.',
    })),
  },
});

test('budget-limited batches retain deferred skills and edits to reviewed skills do not restart the sweep', async (t) => {
  const { core, call } = fixture(t, { executors: { direct: keep } });
  const skills: Skill[] = [];
  for (let i = 0; i < 6; i++)
    skills.push((await call('skills.create', { files: pack('budget-batch-' + i) })) as Skill);
  await call('settings.patch', {
    expected_revision: 0,
    patch: { curator: { max_batch_skills: 2 }, limits: { daily_cost_usd: 0.02 } },
  });
  const first = (await call('curator.optimize', { execution: { max_cost_usd: 0.01 } })) as {
    jobs: Job[];
    next_cursor: number | null;
  };
  assert.equal(first.jobs.length, 2);
  assert.notEqual(first.next_cursor, null);
  assert.ok(
    Math.abs(core.jobs.remainingBudget(scope)) < 1e-9,
    'Queued jobs reserve the full accepted budget',
  );
  await core.tick();
  const reviewed = new Set(first.jobs.flatMap((j) => j.payload.skill_ids as string[]));
  const changed = skills.find((s) => reviewed.has(s.skill_id))!;
  await call('skills.update', {
    skill_id: changed.skill_id,
    expected_revision: changed.revision,
    files: pack(changed.name, 'A revised instruction.'),
  });
  await assert.rejects(
    call('curator.optimize', { execution: { max_cost_usd: 0.01 } }),
    code('budget_exceeded'),
  );
  await call('settings.patch', {
    expected_revision: 1,
    patch: { limits: { daily_cost_usd: 0.03 } },
  });
  const second = (await call('curator.optimize', { execution: { max_cost_usd: 0.01 } })) as {
    jobs: Job[];
    next_cursor: number | null;
  };
  assert.equal(second.jobs.length, 1);
  assert.equal(second.next_cursor, null);
  assert.deepEqual(
    new Set(second.jobs[0]!.payload.skill_ids as string[]),
    new Set(skills.filter((s) => !reviewed.has(s.skill_id)).map((s) => s.skill_id)),
  );
  await core.tick();
  assert.equal(core.jobs.list(scope).filter((j) => j.status === 'completed').length, 3);
});

test('queued work reserves daily budget across operations and pause/resume cannot overbook it', async (t) => {
  const { core, call } = fixture(t, {
    executors: { direct: async () => ({ cost_usd: 0, output: { updates: [] } }) },
  });
  await call('settings.patch', { expected_revision: 0, patch: { limits: { daily_cost_usd: 1 } } });
  const one = (await call('curator.review')) as Job;
  await assert.rejects(call('curator.review'), code('budget_exceeded'));
  await call('jobs.pause', { job_id: one.job_id });
  const two = (await call('curator.review')) as Job;
  await assert.rejects(call('jobs.resume', { job_id: one.job_id }), code('budget_exceeded'));
  assert.equal(core.jobs.get(scope, one.job_id).status, 'interrupted');
  await call('jobs.cancel', { job_id: two.job_id });
  await call('jobs.resume', { job_id: one.job_id });
  await core.tick();
  assert.equal(core.jobs.get(scope, one.job_id).status, 'completed');
});
