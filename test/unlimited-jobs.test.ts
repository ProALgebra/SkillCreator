import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode/plugin';
import plugin from '../src/server.js';
import type { Job } from '../src/jobs.js';
import type { MethodName, RpcInput } from '../src/rpc.js';
import { code, fixture, scope } from './helpers.js';

test('unlimited defaults accept repeated jobs and charge actual costs above the former caps', async (t) => {
  const { core, call } = fixture(
    t,
    {
      executors: { direct: async () => ({ output: { updates: [] }, cost_usd: 7 }) },
    },
    { productionDefaults: true },
  );
  for (let i = 0; i < 4; i++) {
    const job = (await call('curator.review', {
      execution: { mode: 'direct' },
    })) as Job;
    assert.equal(job.max_cost_usd, null);
    await core.tick();
    const complete = core.jobs.get(scope, job.job_id);
    assert.equal(complete.status, 'completed');
    assert.equal(complete.cost, 7);
    assert.equal(complete.cost_known, true);
  }
  assert.equal(core.jobs.remainingBudget(scope), Infinity);
  assert.equal(core.jobs.status(scope).cost, 28);
  assert.deepEqual(
    core.store.all('job_attempts').map((attempt) => (attempt as { reserved: number }).reserved),
    [0, 0, 0, 0],
  );
  for (const table of ['jobs', 'job_attempts', 'events']) {
    JSON.stringify(core.store.all(table), (_key, value: unknown) => {
      if (typeof value === 'number') assert.ok(Number.isFinite(value));
      return value;
    });
  }
});

test('missing and partial provider accounting stays explicitly unknown on unbounded jobs', async (t) => {
  let calls = 0;
  const { core, call } = fixture(
    t,
    {
      executors: {
        direct: async () =>
          calls++ === 0
            ? { output: { updates: [] } }
            : { output: { updates: [] }, cost_usd: 0.04, cost_known: false },
      },
    },
    { productionDefaults: true },
  );
  for (const expected of [0, 0.04]) {
    const job = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
    await core.tick();
    const complete = core.jobs.get(scope, job.job_id);
    assert.equal(complete.status, 'completed');
    assert.equal(complete.cost, expected);
    assert.equal(complete.cost_known, false);
    const attempt = core.store
      .all<{ job_id: string; cost_known: boolean; reserved: number }>('job_attempts')
      .find((attempt) => attempt.job_id === job.job_id)!;
    assert.equal(attempt.cost_known, false);
    assert.equal(attempt.reserved, 0);
  }
  const stats = (await call('stats.costs')) as { cost_usd: number; cost_known: boolean };
  assert.equal(stats.cost_usd, 0.04);
  assert.equal(stats.cost_known, false);
});

test('explicit finite per-job caps still reject overruns with unlimited defaults', async (t) => {
  const { core, call } = fixture(
    t,
    {
      executors: { direct: async () => ({ output: { updates: [] }, cost_usd: 0.8 }) },
    },
    { productionDefaults: true },
  );
  const job = (await call('curator.review', {
    execution: { mode: 'direct', max_cost_usd: 0.5 },
  })) as Job;
  assert.equal(job.max_cost_usd, 0.5);
  await core.tick();
  const failed = core.jobs.get(scope, job.job_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'budget_exceeded');
  assert.equal(failed.cost, 0.8);
  assert.equal(failed.cost_known, true);
});

test('a finite daily cap requires a finite reservation and preserves queue budget accounting', async (t) => {
  const { core, call } = fixture(
    t,
    {
      executors: { direct: async () => ({ output: { updates: [] }, cost_usd: 0.1 }) },
    },
    { productionDefaults: true },
  );
  await call('settings.patch', {
    expected_revision: 0,
    patch: { limits: { daily_cost_usd: 0.6 } },
  });
  await assert.rejects(
    call('curator.review', { execution: { mode: 'direct' } }),
    code('budget_exceeded'),
  );
  const first = (await call('curator.review', {
    execution: { mode: 'direct', max_cost_usd: 0.4 },
  })) as Job;
  await assert.rejects(
    call('curator.review', {
      execution: { mode: 'direct', max_cost_usd: 0.3 },
    }),
    code('budget_exceeded'),
  );
  await core.tick();
  assert.equal(core.jobs.get(scope, first.job_id).cost, 0.1);
  assert.ok(Math.abs(core.jobs.remainingBudget(scope) - 0.5) < 1e-9);
});

test('enabling a daily cap after unaccounted work blocks further spending', async (t) => {
  const { core, call } = fixture(
    t,
    {
      executors: { direct: async () => ({ output: { updates: [] } }) },
    },
    { productionDefaults: true },
  );
  await call('curator.review', { execution: { mode: 'direct' } });
  await core.tick();
  await call('settings.patch', { expected_revision: 0, patch: { limits: { daily_cost_usd: 3 } } });
  assert.equal(core.jobs.remainingBudget(scope), -Infinity);
  await assert.rejects(
    call('curator.review', {
      execution: { mode: 'direct', max_cost_usd: 0.1 },
    }),
    code('budget_exceeded'),
  );
});

test('unbounded failures release known execution slots without claiming unknown cost is free', async (t) => {
  const { core, call } = fixture(t, {}, { productionDefaults: true });
  await call('settings.patch', {
    expected_revision: 0,
    patch: { external_bridge: { enabled: true } },
  });
  const job = core.jobs.run(scope, 'alice', 'review', {}, { mode: 'external' }, 'failed-cost');
  const lease = core.jobs.lease(scope, 'external', 'worker')!;
  const failed = core.jobs.fail(
    scope,
    job.job_id,
    'worker',
    lease.lease_token,
    'Executor rejected the result',
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.cost, 0);
  assert.equal(failed.cost_known, false);
  assert.equal(core.jobs.status(scope).active, 0);
  assert.equal(core.store.all('job_leases').length, 0);
  assert.equal(core.store.all<{ reserved: number }>('job_attempts')[0]?.reserved, 0);
});

test('unbounded uncertain outcomes retain reconciliation and concurrency protection', async (t) => {
  let providerCalls = 0;
  const { core, call } = fixture(
    t,
    {
      executors: {
        direct: async () => {
          providerCalls++;
          throw new Error('Connection closed after dispatch');
        },
      },
    },
    { productionDefaults: true },
  );
  const first = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
  const second = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
  await core.tick();
  assert.equal(core.jobs.get(scope, first.job_id).status, 'unknown_outcome');
  assert.equal(core.jobs.get(scope, first.job_id).cost_known, false);
  assert.equal(core.jobs.get(scope, second.job_id).status, 'queued');
  assert.equal(providerCalls, 1);
  await assert.rejects(call('jobs.retry', { job_id: first.job_id }), code('unknown_outcome'));
  await call('jobs.cancel', {
    job_id: first.job_id,
    confirm_stopped: true,
    reason: 'Provider confirmed stop',
    cost_usd: 0.25,
  });
  assert.equal(core.jobs.get(scope, first.job_id).cost, 0.25);
  assert.equal(core.jobs.get(scope, first.job_id).cost_known, true);
});

test('run reservation accounting includes every held attempt and excludes only the requested attempt', (t) => {
  const { core } = fixture(t, {}, { productionDefaults: true });
  const attempt = (id: string, job_id: string, reserved: number, cost_known = false) => ({
    ...scope,
    id,
    job_id,
    reserved,
    cost: 0,
    cost_known,
    status: 'unknown_outcome',
  });
  core.store.put('job_attempts', 'old-attempt', attempt('old-attempt', 'retrying-job', 0.4));
  core.store.put(
    'job_attempts',
    'current-attempt',
    attempt('current-attempt', 'retrying-job', 0.4),
  );
  core.store.put('job_attempts', 'sibling-attempt', attempt('sibling-attempt', 'sibling-job', 0.2));
  core.store.put('job_attempts', 'other-workspace', {
    ...attempt('other-workspace', 'retrying-job', 10),
    workspace_id: 'elsewhere',
  });
  assert.equal(core.jobs.reservedCost(scope, ['retrying-job', 'sibling-job']), 1);
  assert.ok(
    Math.abs(
      core.jobs.reservedCost(scope, ['retrying-job', 'sibling-job'], 'current-attempt') - 0.6,
    ) < 1e-9,
  );
  assert.equal(core.jobs.reservedCost(scope, ['unknown-job']), 0);
  core.store.put('job_attempts', 'unknown-cost', attempt('unknown-cost', 'unbounded-job', 0));
  assert.equal(core.jobs.reservedCost(scope, ['unbounded-job']), Infinity);
  assert.equal(core.jobs.reservedCost(scope, ['unbounded-job'], 'unknown-cost'), 0);
  core.store.put(
    'job_attempts',
    'bad-reservation',
    attempt('bad-reservation', 'malformed-job', -1),
  );
  assert.equal(core.jobs.reservedCost(scope, ['malformed-job']), Infinity);
});

test('SDK adapters expose unknown prices without a fake cap and block explicit zero before dispatch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'curator-unlimited-sdk-'));
  const token = 'unlimited-sdk-test-capability-0123456789';
  process.env.CURATOR_UNLIMITED_SDK_TOKEN = token;
  let handlers: Record<string, (input: RpcInput, context: unknown) => Promise<unknown>> = {};
  let directCalls = 0;
  let sessionCalls = 0;
  const context = {
    options: {
      token_env: 'CURATOR_UNLIMITED_SDK_TOKEN',
      data_directory: dir,
      workspace_id: 'sdk-unlimited',
    },
    location: { directory: dir, workspaceID: 'sdk-unlimited' },
    skill: {
      list: async () => ({ data: [] }),
      transform: async () => ({ dispose: async () => {} }),
      reload: async () => {},
    },
    rpc: {
      register: async (_definition: unknown, registered: typeof handlers) => {
        handlers = registered;
        return { dispose: async () => {}, events: { emit: async () => {} } };
      },
    },
    tool: { hook: async () => ({ dispose: async () => {} }) },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
    },
    experimental: {
      generate: {
        text: async () => {
          directCalls++;
          return { text: '{"updates":[]}' };
        },
      },
    },
    session: {
      list: async () => ({ data: [], cursor: {} }),
      create: async (input: { id: string }) => {
        sessionCalls++;
        return { id: input.id };
      },
      prompt: async () => {},
      wait: async () => {},
      context: async () => [
        { type: 'assistant', cost: 0.08, content: [{ type: 'text', text: 'Thinking' }] },
        { type: 'assistant', content: [{ type: 'text', text: '{"updates":[]}' }] },
      ],
      interrupt: async () => {},
    },
  } as unknown as Plugin.Context;
  const cleanup = await plugin.setup(context);
  t.after(async () => {
    await cleanup?.();
    delete process.env.CURATOR_UNLIMITED_SDK_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (method: MethodName, input: RpcInput = {}) =>
    handlers[method]!(
      {
        ...input,
        auth: token,
        idempotency_key: randomUUID(),
      },
      {
        error: (code: string, message: string) => {
          throw Object.assign(new Error(message), { code });
        },
      },
    );
  const installed = (await call('settings.get')) as {
    settings: {
      approval: { mode: string };
      curator: { llm_review_enabled: boolean };
      limits: {
        daily_cost_usd: number | null;
        max_job_cost_usd: number | null;
        max_context_tokens: number;
      };
    };
  };
  assert.equal(installed.settings.approval.mode, 'auto');
  assert.equal(installed.settings.curator.llm_review_enabled, true);
  assert.equal(installed.settings.limits.daily_cost_usd, null);
  assert.equal(installed.settings.limits.max_job_cost_usd, null);
  assert.equal(installed.settings.limits.max_context_tokens, 45000);
  const run = async (execution: RpcInput['execution']) => {
    const queued = (await call('curator.review', { execution })) as Job;
    const deadline = Date.now() + 5000;
    for (;;) {
      const job = (await call('jobs.get', { job_id: queued.job_id })) as Job;
      if (['completed', 'failed', 'unknown_outcome'].includes(job.status)) return job;
      assert.ok(Date.now() < deadline, 'SDK adapter job did not settle');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const direct = await run({ mode: 'direct' });
  assert.equal(direct.status, 'completed');
  assert.equal(direct.max_cost_usd, null);
  assert.equal(direct.cost, 0);
  assert.equal(direct.cost_known, false);
  const session = await run({ mode: 'session' });
  assert.equal(session.status, 'completed');
  assert.equal(session.cost, 0.08);
  assert.equal(session.cost_known, false);
  const bounded = await run({ mode: 'direct', max_cost_usd: 0.25 });
  assert.equal(bounded.status, 'completed');
  assert.equal(bounded.cost, 0.25);
  assert.equal(bounded.cost_known, true);
  const zero = await run({ mode: 'direct', max_cost_usd: 0 });
  assert.equal(zero.status, 'failed');
  assert.equal(zero.error?.code, 'budget_exceeded');
  assert.equal(zero.cost, 0);
  assert.equal(zero.cost_known, true);
  assert.equal(directCalls, 2);
  assert.equal(sessionCalls, 1);
});
