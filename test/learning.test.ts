import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, code } from './helpers.js';
import type { Job } from '../src/jobs.js';
import type { Proposal } from '../src/types.js';

const transcript = {
  source_instance: 'verified-import',
  session_id: 'session-one',
  stage_id: 'done',
  content: 'The integration test passed after enabling explicit retries.',
  verified: true,
  source_refs: ['run-123'],
};
const candidate = {
  title: 'Explicit retry policy',
  problem: 'Transient network errors interrupt a job.',
  solution: 'Enable retries before dispatch and keep the durable marker.',
  conditions: ['Known transient failure'],
  evidence: ['The integration test passed after enabling explicit retries.'],
  failures: [],
  confidence: 0.95,
  reusability_score: 0.9,
  source_refs: ['session-one'],
};
test('verified session → candidate → proposal → approval → published skill', async (t) => {
  const { core, call } = fixture(t, {
    executors: { direct: async () => ({ output: { candidates: [candidate] }, cost_usd: 0.1 }) },
  });
  await call('learning.ingest', { transcript });
  const j = (await call('learning.run', {
    session_ids: ['session-one'],
    execution: { mode: 'direct' },
  })) as Job;
  assert.equal(core.catalog.list(scope).length, 0);
  await core.tick();
  const job = core.jobs.get(scope, j.job_id);
  assert.equal(job.status, 'completed');
  assert.equal(core.learning.candidates(scope).length, 1);
  assert.equal(job.proposal_ids.length, 1);
  const p = core.catalog.getProposal(scope, job.proposal_ids[0]!);
  assert.equal(p.status, 'pending');
  assert.equal(core.catalog.list(scope).length, 0);
  await call('proposals.approve', { proposal_id: p.proposal_id, expected_revision: p.revision });
  await call('proposals.apply', { proposal_id: p.proposal_id, expected_revision: 2 });
  const skill = core.catalog.list(scope)[0]!;
  assert.ok(skill.files['SKILL.md']!.includes(candidate.solution));
  assert.ok(skill.source_session_ids.includes(core.learning.candidates(scope)[0]!.candidate_id));
  assert.equal(core.catalog.history(scope, skill.skill_id).length, 1);
  const events = core.store.all<{ type: string }>('events');
  for (const type of [
    'learning.ingested',
    'learning.candidate_created',
    'proposal.created',
    'proposal.approved',
    'proposal.applied',
  ])
    assert.ok(events.some((e) => e.type === type));
});
test('history deduplicates by scope/source/session/stage/content and excludes internal sessions', async (t) => {
  const { call, core } = fixture(t);
  await call('learning.ingest', { transcript });
  await call('learning.ingest', { transcript });
  assert.equal(core.learning.sessions(scope).length, 1);
  core.store.put('control', 'internal:curator-service', { internal: true });
  await call('learning.ingest', { transcript: { ...transcript, session_id: 'curator-service' } });
  await call('learning.ingest', {
    transcript: { ...transcript, session_id: 'internal-import', internal: true },
  });
  assert.equal(core.learning.sessions(scope).length, 1);
});
test('false successes and invented evidence cannot produce learning candidates', async (t) => {
  const { core, call } = fixture(t);
  await call('learning.ingest', { transcript: { ...transcript, verified: false } });
  assert.throws(
    () => core.learning.acceptResult(scope, 'alice', { candidates: [candidate] }, ['session-one']),
    code('validation_error'),
  );
  await call('learning.ingest', {
    transcript: { ...transcript, session_id: 'verified', verified: true },
  });
  assert.throws(
    () =>
      core.learning.acceptResult(
        scope,
        'alice',
        {
          candidates: [
            { ...candidate, source_refs: ['verified'], evidence: ['Invented successful result'] },
          ],
        },
        ['verified'],
      ),
    code('validation_error'),
  );
});
test('secrets are redacted before persistence and model exposure', async (t) => {
  const { core, call } = fixture(t);
  await call('learning.ingest', {
    transcript: { ...transcript, content: 'api_key=do-not-store-this-value\nValidated fix' },
  });
  const stored = JSON.stringify(core.store.all('sessions'));
  assert.equal(stored.includes('do-not-store-this-value'), false);
  assert.equal(
    JSON.stringify(core.learning.buildPayload(scope)).includes('do-not-store-this-value'),
    false,
  );
});
test('reprocessing verified knowledge produces no duplicate candidate or proposal', async (t) => {
  const { core, call } = fixture(t, {
    executors: { direct: async () => ({ output: { candidates: [candidate] }, cost_usd: 0.1 }) },
  });
  await call('learning.ingest', { transcript });
  for (let n = 0; n < 2; n++) {
    await call('learning.run', { session_ids: ['session-one'], execution: { mode: 'direct' } });
    await core.tick();
  }
  assert.equal(core.learning.candidates(scope).length, 1);
  assert.equal(core.store.all<Proposal>('proposals').length, 1);
});
