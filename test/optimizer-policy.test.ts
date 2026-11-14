import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, pack, scope, code } from './helpers.js';
import { CuratorError } from '../src/errors.js';
import type { Job } from '../src/jobs.js';
import type { Proposal } from '../src/types.js';

const quote = 'Stop on authentication errors.';
const body = (
  'Persist the dispatch marker before retrying remote requests. ' +
  quote +
  '\n'
).repeat(10);

for (const automatic of [false, true])
  test(`semantic merge requires its own policy flag (${automatic}) and rollback always needs approval`, async (t) => {
    const { core, call } = fixture(t, {
      executors: {
        direct: async ({ job }) => ({
          cost_usd: 0,
          output: {
            actions: [
              {
                action: 'merge',
                skill_ids: job.payload.skill_ids,
                rationale:
                  'Consolidate repeated retry guidance while preserving the stop condition.',
                name: 'combined-retry-policy',
                files: pack(
                  'combined-retry-policy',
                  'Persist the dispatch marker before retrying. ' + quote,
                ),
                coverage: (job.payload.skill_ids as string[]).map((id) => ({
                  skill_id: id,
                  quotes: [quote],
                })),
              },
            ],
          },
        }),
      },
    });
    for (const name of ['retry-a', 'retry-b'])
      await call('skills.create', { files: pack(name, body) });
    await call('settings.patch', {
      expected_revision: 0,
      patch: {
        approval: {
          mode: 'auto',
          allow_auto_create: true,
          allow_auto_merge: automatic,
        },
      },
    });
    const result = (await call('curator.optimize')) as { jobs: Job[] };
    await core.tick();
    const job = core.jobs.get(scope, result.jobs[0]!.job_id);
    assert.equal(job.status, 'completed');
    let proposal = core.catalog.getProposal(scope, job.proposal_ids[0]!);
    assert.equal(proposal.status, automatic ? 'applied' : 'pending');
    if (!automatic) {
      assert.equal(core.catalog.list(scope).filter((s) => s.state === 'active').length, 2);
      proposal = (await call('proposals.approve', {
        proposal_id: proposal.proposal_id,
        expected_revision: proposal.revision,
      })) as Proposal;
      await call('proposals.apply', {
        proposal_id: proposal.proposal_id,
        expected_revision: proposal.revision,
      });
      proposal = core.catalog.getProposal(scope, proposal.proposal_id);
    }
    const report = core.optimizer.report(scope, job.job_id)!;
    assert.equal(report.before.active_skills, 2);
    assert.equal(report.current.active_skills, 1);
    assert.ok(report.current.instruction_chars < report.before.instruction_chars);
    const inverse = (await call('curator.rollback', {
      proposal_id: proposal.proposal_id,
      expected_revision: proposal.revision,
    })) as Proposal;
    assert.equal(inverse.status, 'pending');
    assert.equal(inverse.automatic, false);
    assert.equal(core.catalog.list(scope).filter((s) => s.state === 'active').length, 1);
    const approved = (await call('proposals.approve', {
      proposal_id: inverse.proposal_id,
      expected_revision: inverse.revision,
    })) as Proposal;
    await call('proposals.apply', {
      proposal_id: approved.proposal_id,
      expected_revision: approved.revision,
    });
    assert.equal(core.catalog.list(scope).filter((s) => s.state === 'active').length, 2);
    for (const name of ['retry-a', 'retry-b'])
      assert.equal(
        core.catalog.list(scope).find((s) => s.name === name)!.files['SKILL.md'],
        pack(name, body)['SKILL.md'],
      );
  });

test('manual publication prevents a merge even when auto-merge is allowed', async (t) => {
  const { core, call } = fixture(t, {
    executors: {
      direct: async ({ job }) => ({
        cost_usd: 0,
        output: {
          actions: [
            {
              action: 'merge',
              skill_ids: job.payload.skill_ids,
              rationale: 'Equivalent retry instructions.',
              files: pack('manual-combined', quote),
              coverage: (job.payload.skill_ids as string[]).map((id) => ({
                skill_id: id,
                quotes: [quote],
              })),
            },
          ],
        },
      }),
    },
  });
  await call('skills.create', { files: pack('manual-a', body) });
  await call('skills.create', { files: pack('manual-b', body) });
  await call('settings.patch', {
    expected_revision: 0,
    patch: { approval: { allow_auto_merge: true } },
  });
  const result = (await call('curator.optimize')) as { jobs: Job[] };
  await core.tick();
  const job = core.jobs.get(scope, result.jobs[0]!.job_id);
  assert.equal(job.status, 'completed');
  assert.equal(core.catalog.getProposal(scope, job.proposal_ids[0]!).status, 'pending');
});

test('a later batch rejection rolls back all queued jobs and the optimization cursor', async (t) => {
  const { core, call } = fixture(t, {
    executors: { direct: async () => ({ output: {}, cost_usd: 0 }) },
  });
  await call('settings.patch', {
    expected_revision: 0,
    patch: { curator: { max_batch_skills: 2 } },
  });
  for (const name of ['batch-a', 'batch-b', 'batch-c'])
    await call('skills.create', { files: pack(name) });
  const run = core.jobs.run.bind(core.jobs);
  let calls = 0;
  core.jobs.run = (...args) => {
    if (++calls === 2)
      throw new CuratorError('budget_exceeded', 'Controlled preacceptance rejection');
    return run(...args);
  };
  await assert.rejects(call('curator.optimize'), code('budget_exceeded'));
  assert.equal(calls, 2);
  assert.equal(core.jobs.list(scope).length, 0);
  assert.equal(
    core.store.all<{ type: string }>('events').filter((e) => e.type === 'job.created').length,
    0,
  );
  assert.equal(
    core.store.all<{ catalog_hash?: string }>('control').filter((r) => r.catalog_hash).length,
    0,
  );
});
