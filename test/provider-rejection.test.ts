import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect, Schema } from 'effect';
import { fixture, scope } from './helpers.js';
import type { Job } from '../src/jobs.js';
import type { DurableEvent } from '../src/types.js';

function providerError(reason: string, status?: number): Error {
  return Object.assign(new Error('Free usage limit reached. api_key=test-only-provider-secret'), {
    _tag: 'ProviderRequestError',
    providerID: 'test-provider',
    reason,
    ...(status === undefined ? {} : { status }),
  });
}

class NativeProviderError extends Schema.TaggedError<NativeProviderError>()(
  'Generate.ProviderRequestError',
  {
    providerID: Schema.String,
    reason: Schema.String,
    status: Schema.Number,
    message: Schema.String,
  },
) {}

test('native Generate refusal survives real Effect.runPromise and releases the job slot', async (t) => {
  const refusal = new NativeProviderError({
    providerID: 'test-provider',
    reason: 'rate_limit',
    status: 429,
    message: 'Free usage limit reached. api_key=native-test-only-secret',
  });
  // Effect 4 rejects with the original typed failure, without a FiberFailure wrapper.
  await assert.rejects(Effect.runPromise(Effect.fail(refusal)), (error) => error === refusal);
  let calls = 0;
  const { core, call } = fixture(t, {
    executors: {
      direct: () =>
        calls++ === 0
          ? Effect.runPromise(Effect.fail(refusal))
          : Promise.resolve({ output: { updates: [] }, cost_usd: 0 }),
    },
  });
  const first = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
  const next = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
  await core.tick();
  const failed = core.jobs.get(scope, first.job_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.cost, 0);
  assert.deepEqual(failed.error, {
    code: 'rate_limited',
    message: 'Free usage limit reached. api_key=[REDACTED_SECRET]',
  });
  assert.equal(core.jobs.get(scope, next.job_id).status, 'completed');
  assert.equal(calls, 2);
});

test('provider rate rejection releases budget and concurrency for the next job without fallback', async (t) => {
  let calls = 0;
  let fallbackCalls = 0;
  const { core, call } = fixture(t, {
    executors: {
      direct: async () => {
        if (calls++ === 0) throw providerError('rate_limit', 429);
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
  const rejected = (await call('curator.review', { execution: { mode: 'auto' } })) as Job;
  const next = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;

  await core.tick();

  const failed = core.jobs.get(scope, rejected.job_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.cost, 0);
  assert.deepEqual(failed.error, {
    code: 'rate_limited',
    message: 'Free usage limit reached. api_key=[REDACTED_SECRET]',
  });
  assert.equal(core.jobs.get(scope, next.job_id).status, 'completed');
  assert.equal(core.jobs.get(scope, next.job_id).cost, 0.25);
  assert.equal(calls, 2);
  assert.equal(fallbackCalls, 0);
  assert.equal(core.jobs.status(scope).unknown, 0);
  const attempts = core.store.all<{ status: string; cost: number; reserved: number }>(
    'job_attempts',
  );
  assert.equal(
    attempts.reduce((sum, a) => sum + a.reserved, 0),
    0,
  );
  assert.equal(attempts.find((a) => a.status === 'failed')?.cost, 0);
  const events = core.store
    .all<DurableEvent>('events')
    .filter((e) => e.type === 'job.failed' && e.entity_id === rejected.job_id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.details.code, 'rate_limited');
});

test('authentication and invalid-request refusals preserve a redacted provider reason', async (t) => {
  for (const [reason, status] of [
    ['authentication', 401],
    ['authentication', 403],
    ['invalid_request', 400],
    ['invalid_request', 422],
  ] as const) {
    const { core, call } = fixture(t, {
      executors: { direct: async () => Promise.reject(providerError(reason, status)) },
    });
    const job = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
    await core.tick();
    const failed = core.jobs.get(scope, job.job_id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.cost, 0);
    assert.deepEqual(failed.error, {
      code: 'executor_unavailable',
      message: 'Free usage limit reached. api_key=[REDACTED_SECRET]',
    });
  }
});

test('network errors and ambiguous provider failures retain reservation and prevent another dispatch', async (t) => {
  for (const failure of [
    new Error('Connection closed after request was sent'),
    providerError('provider', 503),
    new NativeProviderError({
      providerID: 'test-provider',
      reason: 'provider',
      status: 503,
      message: 'Response lost after the provider started work',
    }),
    providerError('rate_limit', 500),
    providerError('authentication', 429),
    providerError('rate_limit'),
    { reason: 'rate_limit', status: 429, message: 'Unverified error shape' },
  ]) {
    let calls = 0;
    let fallbackCalls = 0;
    const { core, call } = fixture(t, {
      executors: {
        direct: async () => {
          calls++;
          throw failure;
        },
        session: async () => {
          fallbackCalls++;
          return { output: { updates: [] }, cost_usd: 0 };
        },
      },
    });
    const first = (await call('curator.review', { execution: { mode: 'auto' } })) as Job;
    const next = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
    await core.tick();
    assert.equal(core.jobs.get(scope, first.job_id).status, 'unknown_outcome');
    assert.equal(core.jobs.get(scope, first.job_id).error?.code, 'unknown_outcome');
    assert.equal(core.jobs.get(scope, next.job_id).status, 'queued');
    assert.equal(calls, 1);
    assert.equal(fallbackCalls, 0);
    const attempts = core.store.all<{ reserved: number }>('job_attempts');
    assert.equal(
      attempts.reduce((sum, a) => sum + a.reserved, 0),
      first.max_cost_usd,
    );
  }
});
