import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, pack, owner } from './helpers.js';
import type { CuratorCore } from '../src/core.js';
import type { Job } from '../src/jobs.js';
import type { Skill } from '../src/types.js';
import type { Principal } from '../src/types.js';
import { CuratorScheduler } from '../src/curator-scheduler.js';

const quote = 'The durable marker integration test passed.';
test('fresh defaults publish new conversation skills and eligible refinements without manual approval', async (t) => {
  let core!: CuratorCore;
  let target: Skill | undefined;
  const f = fixture(
    t,
    {
      conversations: { list: async () => [], read: async () => ({ content: quote }) },
      executors: {
        direct: async ({ job }) => {
          core.modelPayload(job);
          return {
            output: {
              candidates: [
                {
                  name: 'automatic-marker-retries',
                  ...(target ? { target_skill_id: target.skill_id } : {}),
                  title: 'Durable marker retries',
                  problem: 'Retries can duplicate requests.',
                  solution: target
                    ? 'Retain the durable marker until the result is recorded.'
                    : 'Record a durable marker before retrying a remote request.',
                  conditions: [],
                  evidence: [quote],
                  failures: [],
                  confidence: 0.95,
                  reusability_score: 0.9,
                  source_refs: job.source_refs,
                },
              ],
            },
          };
        },
      },
    },
    { productionDefaults: true },
  );
  core = f.core;
  const settings = core.settings.get(scope).settings;
  assert.equal(settings.limits.daily_cost_usd, null);
  assert.equal(settings.limits.max_job_cost_usd, null);
  assert.equal(settings.limits.max_context_tokens, 45000);
  assert.equal(settings.approval.mode, 'auto');
  assert.equal(settings.curator.llm_review_enabled, true);
  for (let pass = 0; pass < 2; pass++) {
    const job = (await f.call('learning.refine', { session_ids: ['automatic-source'] })) as Job;
    await core.tick();
    const done = core.jobs.get(scope, job.job_id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(done.max_cost_usd, null);
    assert.equal(done.cost_known, false);
    assert.equal(core.catalog.getProposal(scope, done.proposal_ids[0]!).status, 'applied');
    target = core.catalog.list(scope)[0]!;
  }
  assert.equal(core.catalog.list(scope).length, 1);
  assert.equal(target!.revision, 2);
  const costs = (await f.call('stats.costs')) as { cost_known: boolean; cost_usd: number };
  assert.equal(costs.cost_known, false);
  assert.equal(costs.cost_usd, 0, 'Numeric cost is only the known subtotal');
});

test('fresh defaults automatically apply semantic consolidation while preserving source versions', async (t) => {
  const instruction = 'Stop on authentication errors.';
  const body = ('Persist the dispatch marker before retrying. ' + instruction + '\n').repeat(10);
  const f = fixture(
    t,
    {
      executors: {
        direct: async ({ job }) => ({
          output: {
            actions: [
              {
                action: 'merge',
                skill_ids: job.payload.skill_ids,
                rationale:
                  'Consolidate identical retry instructions while retaining the stop condition.',
                name: 'automatic-retry-consolidation',
                files: pack(
                  'automatic-retry-consolidation',
                  'Persist the dispatch marker before retrying. ' + instruction,
                ),
                coverage: (job.payload.skill_ids as string[]).map((id) => ({
                  skill_id: id,
                  quotes: [instruction],
                })),
              },
            ],
          },
        }),
      },
    },
    { productionDefaults: true },
  );
  const sources: Skill[] = [];
  for (const name of ['automatic-source-a', 'automatic-source-b'])
    sources.push((await f.call('skills.create', { files: pack(name, body) })) as Skill);
  const run = (await f.call('curator.optimize')) as { jobs: Job[] };
  await f.core.tick();
  const done = f.core.jobs.get(scope, run.jobs[0]!.job_id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.equal(f.core.catalog.getProposal(scope, done.proposal_ids[0]!).status, 'applied');
  assert.equal(f.core.catalog.list(scope).filter((s) => s.state === 'active').length, 1);
  for (const source of sources) {
    assert.equal(f.core.catalog.get(scope, source.skill_id).state, 'superseded');
    assert.equal(
      f.core.catalog.history(scope, source.skill_id)[0]!.skill.files['SKILL.md'],
      source.files['SKILL.md'],
    );
  }
});

test('fresh default curator schedule invokes semantic review after its normal interval', async (t) => {
  const f = fixture(t, {}, { productionDefaults: true });
  const start = Date.UTC(2026, 10, 15, 0);
  const scheduler = new CuratorScheduler(f.core.store, scope, start);
  const calls: string[] = [];
  await scheduler.drain({
    settings: f.core.settings.get(scope).settings,
    paused: false,
    now: start + 168 * 3_600_000,
    readState: async () => ({ idle: true }),
    lifecycle: async () => {
      calls.push('lifecycle');
    },
    optimize: async () => {
      calls.push('semantic');
      return { run_id: 'default-semantic-pass', jobs: [] };
    },
  });
  assert.deepEqual(calls, ['lifecycle', 'semantic']);
});

test('unbounded external RPC completion preserves a known subtotal with an explicit unknown-cost marker', async (t) => {
  const f = fixture(t, {}, { productionDefaults: true });
  await f.call('settings.patch', {
    expected_revision: 0,
    patch: { external_bridge: { enabled: true } },
  });
  const worker: Principal = {
    ...owner,
    subject: 'default-worker',
    roles: ['worker'],
    worker_kind: 'external',
  };
  const job = (await f.call('curator.review', { execution: { mode: 'external' } })) as Job;
  const lease = (await f.call(
    'jobs.lease',
    { worker_kind: 'external', worker_id: worker.subject },
    worker,
  )) as { job: Job; lease_token: string };
  assert.equal(lease.job.max_cost_usd, null);
  const done = (await f.call(
    'jobs.complete',
    {
      job_id: job.job_id,
      worker_id: worker.subject,
      lease_token: lease.lease_token,
      result: { updates: [] },
      cost_usd: 0.25,
      cost_known: false,
    },
    worker,
  )) as Job;
  assert.equal(done.status, 'completed');
  assert.equal(done.cost, 0.25);
  assert.equal(done.cost_known, false);
  const stats = (await f.call('stats.costs')) as { cost_usd: number; cost_known: boolean };
  assert.equal(stats.cost_usd, 0.25);
  assert.equal(stats.cost_known, false);
  const serialized = JSON.stringify(await f.call('jobs.get', { job_id: job.job_id }));
  assert.equal(serialized.includes('Infinity'), false);
  assert.equal(JSON.parse(serialized).max_cost_usd, null);
});
