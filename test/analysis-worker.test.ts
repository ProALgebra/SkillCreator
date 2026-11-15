import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CuratorCore } from '../src/core.js';
import type { Job } from '../src/jobs.js';
import type { Principal } from '../src/types.js';
import type { MethodName, RpcInput } from '../src/rpc.js';
import { fixture, scope, owner, code } from './helpers.js';

const quote = 'The marker test passed after the durable correction.';
const content = ('Inspect a routine diagnostic. '.repeat(25) + '\n\n').repeat(90) + quote;
const conversations = { list: async () => [], read: async () => ({ content }) };
const worker: Principal = {
  ...owner,
  subject: 'analysis-worker',
  roles: ['worker'],
  worker_kind: 'external',
};
interface Lease {
  job: Job;
  context: Record<string, unknown>;
  lease_token: string;
}
function harness(core: CuratorCore) {
  const call = (method: MethodName, input: RpcInput = {}, principal = owner) =>
    core.call(method, { ...input, idempotency_key: randomUUID() }, principal);
  return {
    call,
    lease: () =>
      call('jobs.lease', { worker_kind: 'external', worker_id: worker.subject }, worker) as Promise<
        Lease | { job: null }
      >,
    complete: (
      lease: Lease,
      result: unknown = {
        candidates: [],
        ...(lease.job.payload.analysis_phase === 'final' ? {} : { observations: [] }),
      },
    ) =>
      call(
        'jobs.complete',
        {
          job_id: lease.job.job_id,
          worker_id: worker.subject,
          lease_token: lease.lease_token,
          result,
          cost_usd: 0,
        },
        worker,
      ),
  };
}
async function setup(h: ReturnType<typeof harness>) {
  await h.call('settings.patch', {
    expected_revision: 0,
    patch: {
      external_bridge: { enabled: true },
      privacy: { send_raw_transcripts_to_external: true },
      limits: { max_context_tokens: 8000 },
    },
  });
  return h.call('learning.refine', {
    session_ids: ['worker-conversation'],
    execution: { mode: 'external' },
  }) as Promise<Job>;
}

test('external analysis resumes completed parts after restart without replay or exposed transcript metadata', async (t) => {
  const f = fixture(t, { conversations });
  let core = f.core;
  let h = harness(core);
  const parent = await setup(h);
  const first = (await h.lease()) as Lease;
  assert.equal(first.job.payload.part_index, 0);
  await h.complete(first);
  assert.equal(core.jobs.get(scope, first.job.job_id).status, 'completed');
  await core.close();
  core = new CuratorCore({ dataDirectory: f.dir, conversations });
  t.after(() => core.close());
  h = harness(core);
  const delivered: string[] = [];
  for (let iteration = 0; iteration < 64; iteration++) {
    const lease = await h.lease();
    if (!lease.job) break;
    delivered.push(lease.job.job_id);
    assert.notEqual(lease.job.job_id, first.job.job_id);
    await h.complete(lease as Lease);
  }
  assert.ok(delivered.length > 1);
  assert.equal(core.jobs.get(scope, parent.job_id).status, 'completed');
  assert.equal(
    core.learning.sessions(scope).every((s) => s.processed),
    true,
  );
  assert.equal(
    JSON.stringify(core.store.all('jobs')).includes('Inspect a routine diagnostic'),
    false,
  );
  assert.equal(core.store.all('job_leases').length, 0);
});

test('pausing accepted extraction retains its result and cancellation prevents further lease acceptance', async (t) => {
  const { core } = fixture(t, { conversations });
  const h = harness(core);
  const parent = await setup(h);
  const first = (await h.lease()) as Lease;
  await assert.rejects(
    h.call('jobs.pause', { job_id: first.job.job_id }),
    code('validation_error'),
  );
  await h.call('jobs.pause', { job_id: parent.job_id });
  await h.complete(first);
  assert.equal(core.jobs.get(scope, first.job.job_id).status, 'completed');
  assert.equal(core.store.all('analysis_results').length, 1);
  assert.equal(core.store.all('proposals').length, 0);
  assert.equal((await h.lease()).job, null);
  await h.call('jobs.resume', { job_id: parent.job_id });
  const next = (await h.lease()) as Lease;
  assert.equal(next.job.payload.part_index, 1);
  await h.call('jobs.cancel', { job_id: parent.job_id });
  await h.complete(next);
  assert.equal(core.jobs.get(scope, next.job.job_id).status, 'cancelled');
  assert.equal(core.jobs.get(scope, parent.job_id).status, 'cancelled');
  assert.equal((await h.lease()).job, null);
  assert.equal(
    core.learning.sessions(scope).some((s) => s.processed),
    false,
  );
});

test('pausing an accepted final result defers proposals until resume without another model call', async (t) => {
  const { core } = fixture(t, { conversations });
  const h = harness(core);
  const parent = await setup(h);
  let evidenceRef: string | undefined;
  let final!: Lease;
  for (let iteration = 0; iteration < 64; iteration++) {
    const lease = (await h.lease()) as Lease;
    assert.ok(lease.job);
    if (lease.job.payload.analysis_phase === 'final') {
      final = lease;
      break;
    }
    const source = lease.context.snapshot as { content: string };
    const observations = source.content.includes(quote)
      ? [
          {
            text: 'The correction was observed successful.',
            evidence: [quote],
            source_refs: lease.job.source_refs,
          },
        ]
      : [];
    if (observations.length) evidenceRef = lease.job.source_refs[0];
    await h.complete(lease, { candidates: [], observations });
  }
  assert.ok(final);
  assert.ok(evidenceRef);
  const attempts = core.store.all('job_attempts').length;
  await h.call('jobs.pause', { job_id: parent.job_id });
  await h.complete(final, {
    candidates: [
      {
        name: 'durable-worker-markers',
        title: 'Durable worker markers',
        problem: 'Remote retries can duplicate dispatch.',
        solution: 'Persist a durable marker before retrying.',
        conditions: [],
        evidence: [quote],
        failures: [],
        confidence: 0.9,
        reusability_score: 0.9,
        source_refs: [evidenceRef],
      },
    ],
  });
  assert.equal(core.jobs.get(scope, parent.job_id).status, 'interrupted');
  assert.equal(core.store.all('proposals').length, 0);
  assert.equal(
    core.learning.sessions(scope).some((s) => s.processed),
    false,
  );
  await h.call('jobs.resume', { job_id: parent.job_id });
  assert.equal(core.jobs.get(scope, parent.job_id).status, 'completed');
  assert.equal(core.store.all('proposals').length, 1);
  assert.equal(
    core.learning.sessions(scope).every((s) => s.processed),
    true,
  );
  assert.equal(core.store.all('job_attempts').length, attempts);
});

test('expired accepted parts cannot be silently retried through either parent or child', async (t) => {
  const { core } = fixture(t, { conversations });
  const h = harness(core);
  const parent = await setup(h);
  const first = (await h.lease()) as Lease;
  const saved = core.store.get<Record<string, unknown>>('job_leases', first.job.job_id)!;
  core.store.put('job_leases', first.job.job_id, {
    ...saved,
    expires_at: '2000-01-01T00:00:00.000Z',
  });
  await core.tick();
  assert.equal(core.jobs.get(scope, first.job.job_id).status, 'unknown_outcome');
  assert.equal(core.jobs.get(scope, parent.job_id).status, 'failed');
  await assert.rejects(h.call('jobs.retry', { job_id: parent.job_id }), code('unknown_outcome'));
  await assert.rejects(
    h.call('jobs.retry', { job_id: first.job.job_id }),
    code('validation_error'),
  );
  assert.equal((await h.lease()).job, null);
  assert.equal(core.store.all('job_attempts').length, 1);
});
