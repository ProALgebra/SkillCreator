import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, owner, code, pack } from './helpers.js';
import type { CuratorCore } from '../src/core.js';
import type { Job } from '../src/jobs.js';
import type { Skill, Proposal } from '../src/types.js';
import type { Conversations } from '../src/refine.js';
import { fitsContext } from '../src/context.js';

const evidence = 'The retry integration test passed with a durable dispatch marker.';
const content = [
  'user: Network failures duplicate a dispatch. Please preserve the marker before retrying.',
  'tool: An earlier retry duplicated the request.',
  'assistant: Store the dispatch marker before retrying the request.',
  'tool: ' + evidence,
  'assistant: The corrected procedure uses the marker and bounded retries.',
].join('\n');
const history: Conversations = {
  list: async (requested) => {
    assert.deepEqual(requested, scope);
    return [{ session_id: 'historical-session', title: 'Retry investigation' }];
  },
  read: async (requested, id) => {
    assert.deepEqual(requested, scope);
    assert.equal(id, 'historical-session');
    return {
      content,
      model: { provider: 'provider-from-session', model: 'session-model', variant: 'thoughtful' },
    };
  },
};
const candidate = (job: Job, extra: Record<string, unknown> = {}) => ({
  name: 'durable-network-retries',
  title: 'Preserve dispatch markers',
  problem: 'Transient failures can duplicate remote dispatches.',
  solution: 'Persist a durable dispatch marker before retrying the request, and bound retries.',
  conditions: ['Transient request failure'],
  evidence: [evidence],
  failures: ['Retrying before recording the marker duplicated a dispatch.'],
  confidence: 0.92,
  reusability_score: 0.9,
  source_refs: job.source_refs,
  ...extra,
});
async function patchApproval(
  call: ReturnType<typeof fixture>['call'],
  core: CuratorCore,
  patch: Record<string, unknown>,
) {
  await call('settings.patch', {
    expected_revision: core.settings.get(scope).revision,
    patch: { approval: patch },
  });
}

test('historical conversation review creates an unverified candidate and reviewable proposal, then publishes after approval', async (t) => {
  let captured: Record<string, unknown> | undefined;
  let core!: CuratorCore;
  const result = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => {
        captured = core.modelPayload(job);
        return { output: { candidates: [candidate(job)] }, cost_usd: 0.01 };
      },
    },
  });
  core = result.core;
  const { call } = result;
  assert.deepEqual(((await call('learning.sessions')) as { items: unknown[] }).items, [
    { session_id: 'historical-session', title: 'Retry investigation' },
  ]);
  const queued = (await call('learning.refine', {
    session_ids: ['historical-session'],
    reason: 'Focus on duplicate dispatch prevention',
  })) as Job;
  assert.equal(queued.execution.provider, 'provider-from-session');
  assert.equal(queued.execution.model, 'session-model');
  assert.equal(queued.execution.variant, 'thoughtful');
  assert.equal(JSON.stringify(queued.payload).includes(evidence), false);
  assert.equal(core.learning.sessions(scope)[0]!.verified, false);
  assert.equal(
    core.learning.buildPayload(scope).sessions.length,
    0,
    'strict verified learning must not consume a conversation',
  );
  await core.tick();
  const completed = core.jobs.get(scope, queued.job_id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.proposal_ids.length, 1);
  assert.match(captured!.system_prompt as string, /UNTRUSTED/);
  assert.equal(
    (captured!.snapshot as { evidence_kind: string }).evidence_kind,
    'unverified_conversation',
  );
  assert.equal(captured!.focus, 'Focus on duplicate dispatch prevention');
  assert.equal(core.catalog.list(scope).length, 0);
  const proposal = core.catalog.getProposal(scope, completed.proposal_ids[0]!);
  assert.equal(proposal.status, 'pending');
  assert.match(proposal.rationale, /not independently verified/);
  const storedCandidate = core.learning.candidates(scope)[0] as unknown as {
    evidence_kind: string;
  };
  assert.equal(storedCandidate.evidence_kind, 'conversation_snapshot');
  assert.equal(core.learning.sessions(scope)[0]!.processed, true);
  const approved = (await call('proposals.approve', {
    proposal_id: proposal.proposal_id,
    expected_revision: proposal.revision,
  })) as Proposal;
  await call('proposals.apply', {
    proposal_id: proposal.proposal_id,
    expected_revision: approved.revision,
  });
  const skill = core.catalog.list(scope)[0]!;
  assert.equal(skill.name, 'durable-network-retries');
  assert.match(skill.files['SKILL.md']!, /Failures and corrections/);
  assert.match(skill.files['SKILL.md']!, /not independent verification/);
});

test('refine preview and unchanged idempotent retry do not persist additional snapshots or jobs', async (t) => {
  const { core, call } = fixture(t, {
    conversations: history,
    executors: { direct: async () => ({ output: { candidates: [] }, cost_usd: 0 }) },
  });
  const input = {
    session_ids: ['historical-session'],
    execution: { mode: 'direct' as const },
    idempotency_key: 'same-review',
  };
  await call('learning.refine', { ...input, dry_run: true });
  assert.equal(core.learning.sessions(scope).length, 0);
  assert.equal(core.jobs.list(scope).length, 0);
  const first = (await call('learning.refine', input)) as Job;
  const second = (await call('learning.refine', input)) as Job;
  assert.equal(first.job_id, second.job_id);
  assert.equal(core.learning.sessions(scope).length, 1);
  assert.equal(core.jobs.list(scope).length, 1);
  await assert.rejects(
    call('learning.refine', { ...input, reason: 'different focus' }),
    code('idempotency_conflict'),
  );
});

test('large conversation review preserves the complete redacted source and processes it only after final reconciliation', async (t) => {
  let core!: CuratorCore;
  const contexts: Record<string, unknown>[] = [];
  const redacted =
    'api_key=[REDACTED_SECRET]\n' + 'Very long tool output. '.repeat(10000) + '\n' + evidence;
  let finalized = false;
  const { core: created, call } = fixture(t, {
    conversations: {
      ...history,
      read: async () => ({
        content:
          'api_key=never-store-this-secret\n' +
          'Very long tool output. '.repeat(10000) +
          '\n' +
          evidence,
      }),
    },
    executors: {
      direct: async ({ job }) => {
        const context = core.modelPayload(job);
        contexts.push(context);
        assert.equal(fitsContext(context, core.settings.get(scope).settings, job.execution), true);
        assert.equal(JSON.stringify(context).includes('never-store-this-secret'), false);
        assert.ok(
          core.learning.sessions(scope).every((source) => !source.processed),
          'Extraction and intermediate reconciliation must not mark source records processed',
        );
        if (job.payload.analysis_phase === 'final') {
          finalized = true;
          return { output: { candidates: [] }, cost_usd: 0 };
        }
        return { output: { candidates: [], observations: [] }, cost_usd: 0 };
      },
    },
  });
  core = created;
  await call('settings.patch', {
    expected_revision: 0,
    patch: { limits: { max_context_tokens: 8000 } },
  });
  const job = (await call('learning.refine', { session_ids: ['historical-session'] })) as Job;
  assert.equal(job.status, 'waiting_parts');
  assert.equal(job.payload.truncated, false);
  assert.ok((job.payload.part_count as number) > 1);
  assert.equal(
    JSON.stringify(core.store.all('sessions')).includes('never-store-this-secret'),
    false,
  );
  const source = core.learning
    .sessions(scope)
    .find((item) => item.stage_id.startsWith('snapshot:'))!;
  assert.equal(source.content, redacted, 'The entire redacted source must remain available');
  assert.ok(core.learning.sessions(scope).every((item) => !item.processed));
  await core.tick();
  assert.equal(core.jobs.get(scope, job.job_id).status, 'completed');
  assert.equal(finalized, true);
  let covered = 0;
  let rebuilt = '';
  const extractions = contexts.filter((context) => context.snapshot);
  assert.equal(extractions.length, job.payload.part_count);
  for (const context of extractions) {
    const part = context.part as { start: number; end: number };
    const snapshot = context.snapshot as { content: string; truncated: boolean };
    assert.equal(snapshot.truncated, false);
    assert.ok(
      part.start <= covered && part.end > covered,
      'Parts must cover the source without gaps',
    );
    assert.equal(snapshot.content, redacted.slice(part.start, part.end));
    rebuilt += snapshot.content.slice(covered - part.start);
    covered = part.end;
  }
  assert.equal(rebuilt, redacted);
  assert.ok(core.learning.sessions(scope).every((item) => item.processed));
});

test('conversation evidence rejects an invented quote and references to another snapshot', async (t) => {
  let variant = 0;
  const { core, call } = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => ({
        output: {
          candidates: [
            candidate(
              job,
              variant++ === 0
                ? { evidence: ['The imaginary test passed.'] }
                : { source_refs: ['historical-session'] },
            ),
          ],
        },
        cost_usd: 0,
      }),
    },
  });
  for (let i = 0; i < 2; i++) {
    const job = (await call('learning.refine', { session_ids: ['historical-session'] })) as Job;
    await core.tick();
    assert.equal(core.jobs.get(scope, job.job_id).status, 'failed');
    assert.equal(core.jobs.get(scope, job.job_id).error?.code, 'validation_error');
  }
  assert.equal(core.learning.candidates(scope).length, 0);
  assert.equal(core.store.all('proposals').length, 0);
});

test('JSON snapshots accept exact decoded message quotations and their stored escaped representation', async (t) => {
  const quotation = 'The command "npm test" passed.\nThe dispatch marker prevented duplication.';
  const snapshot = JSON.stringify([{ role: 'assistant', content: [{ text: quotation }] }]);
  assert.equal(snapshot.includes(quotation), false, 'Native context JSON escapes message text');
  const escaped = JSON.stringify(quotation).slice(1, -1);
  const { core, call } = fixture(t, {
    conversations: { ...history, read: async () => ({ content: snapshot }) },
    executors: {
      direct: async ({ job }) => ({
        output: { candidates: [candidate(job, { evidence: [quotation, escaped] })] },
        cost_usd: 0,
      }),
    },
  });
  const job = (await call('learning.refine', { session_ids: ['historical-session'] })) as Job;
  await core.tick();
  assert.equal(core.jobs.get(scope, job.job_id).status, 'completed');
  assert.equal(core.jobs.get(scope, job.job_id).proposal_ids.length, 1);
  assert.deepEqual(core.learning.candidates(scope)[0]!.evidence, [quotation, escaped]);
});

test('JSON evidence never decodes keys, recursively interprets tool strings or repairs truncated context', async (t) => {
  const decoded = 'The command "test" passed.\nThe marker was stored.';
  const encoded = JSON.stringify(decoded).slice(1, -1);
  let snapshot = '';
  let quote = decoded;
  const { core, call } = fixture(t, {
    conversations: { ...history, read: async () => ({ content: snapshot }) },
    executors: {
      direct: async ({ job }) => ({
        output: { candidates: [candidate(job, { evidence: [quote] })] },
        cost_usd: 0,
      }),
    },
  });
  for (const content of [
    JSON.stringify({ [decoded]: 'This value contains no successful result.' }),
    JSON.stringify({ text: JSON.stringify({ result: decoded }) }),
    '{"text":"' + encoded,
  ]) {
    snapshot = content;
    const job = (await call('learning.refine', { session_ids: ['historical-session'] })) as Job;
    await core.tick();
    assert.equal(core.jobs.get(scope, job.job_id).error?.code, 'validation_error');
  }
  assert.equal(core.learning.candidates(scope).length, 0);
  assert.equal(core.store.all('proposals').length, 0);
  quote = encoded;
  const raw = (await call('learning.refine', { session_ids: ['historical-session'] })) as Job;
  await core.tick();
  assert.equal(
    core.jobs.get(scope, raw.job_id).status,
    'completed',
    'Truncated snapshots still support exact raw quotations',
  );
});

test('updates preserve package resources and old guidance and publish with the captured revision', async (t) => {
  let target!: Skill;
  const { core, call } = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => ({
        output: {
          candidates: [candidate(job, { name: target.name, target_skill_id: target.skill_id })],
        },
        cost_usd: 0,
      }),
    },
  });
  target = (await call('skills.create', {
    files: {
      ...pack(
        'retry-procedure',
        'Keep existing scheduling guidance.\nSee [helper](scripts/retry.sh).',
      ),
      'scripts/retry.sh': '#!/bin/sh\nexit 0\n',
      'references/failures.txt': 'Keep the troubleshooting notes.',
    },
  })) as Skill;
  const job = (await call('learning.refine', { session_ids: ['historical-session'] })) as Job;
  await core.tick();
  assert.equal(core.jobs.get(scope, job.job_id).status, 'completed');
  const proposal = core.catalog.getProposal(
    scope,
    core.jobs.get(scope, job.job_id).proposal_ids[0]!,
  );
  assert.equal(proposal.operation, 'patch');
  assert.equal(proposal.changes[0]!.expected_revision, target.revision);
  assert.equal(proposal.changes[0]!.expected_package_hash, target.package_hash);
  assert.equal(proposal.changes[0]!.files!['scripts/retry.sh'], target.files['scripts/retry.sh']);
  assert.equal(
    proposal.changes[0]!.files!['references/failures.txt'],
    target.files['references/failures.txt'],
  );
  assert.match(proposal.changes[0]!.files!['SKILL.md']!, /Keep existing scheduling guidance/);
  const approved = (await call('proposals.approve', {
    proposal_id: proposal.proposal_id,
    expected_revision: proposal.revision,
  })) as Proposal;
  await call('proposals.apply', {
    proposal_id: proposal.proposal_id,
    expected_revision: approved.revision,
  });
  assert.equal(core.catalog.get(scope, target.skill_id).revision, target.revision + 1);
});

test('a skill changed after queueing cannot be updated by conversation review', async (t) => {
  let target!: Skill;
  const { core, call } = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => ({
        output: {
          candidates: [candidate(job, { name: target.name, target_skill_id: target.skill_id })],
        },
        cost_usd: 0,
      }),
    },
  });
  target = (await call('skills.create', { files: pack('retry-procedure') })) as Skill;
  const job = (await call('learning.refine', { session_ids: ['historical-session'] })) as Job;
  await call('skills.update', {
    skill_id: target.skill_id,
    expected_revision: target.revision,
    files: pack(target.name, 'A newer human change.'),
  });
  await core.tick();
  assert.equal(core.jobs.get(scope, job.job_id).error?.code, 'revision_conflict');
  assert.equal(core.store.all('proposals').length, 0);
  assert.equal(core.learning.candidates(scope).length, 0);
});

test('manual, locked, pinned, readonly and other-workspace targets cannot be changed or bypassed with a duplicate name', async (t) => {
  let selected!: Skill;
  const { core, call } = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => ({
        output: {
          candidates: [candidate(job, { name: selected.name, target_skill_id: selected.skill_id })],
        },
        cost_usd: 0,
      }),
    },
  });
  const variants: Array<Partial<Skill>> = [
    { management_policy: 'manual' },
    { locked: true },
    { pinned: true },
    { management_policy: 'readonly' },
    { workspace_id: 'different-workspace' },
  ];
  for (const [i, variant] of variants.entries()) {
    const skill = (await call('skills.create', { files: pack('protected-' + i) })) as Skill;
    selected = { ...skill, ...variant };
    core.store.put('skills', selected.skill_id, selected);
    const job = (await call('learning.refine', { session_ids: ['historical-session'] })) as Job;
    await core.tick();
    assert.equal(core.jobs.get(scope, job.job_id).error?.code, 'scope_violation');
  }
  assert.equal(core.store.all('proposals').length, 0);
  const protectedName = core.catalog.list(scope)[0]!.name;
  assert.throws(
    () =>
      core.conversationReview.acceptResult(core.jobs.list(scope)[0]!, {
        candidates: [candidate(core.jobs.list(scope)[0]!, { name: protectedName })],
      }),
    code('revision_conflict'),
  );
});

test('new skills remain pending in auto mode unless auto-create is explicitly enabled', async (t) => {
  const { core, call } = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => ({ output: { candidates: [candidate(job)] }, cost_usd: 0 }),
    },
  });
  await patchApproval(call, core, { mode: 'auto', allow_auto_patch_managed_low_risk: true });
  const job = (await call('learning.refine', { session_ids: ['historical-session'] })) as Job;
  await core.tick();
  assert.equal(
    core.catalog.getProposal(scope, core.jobs.get(scope, job.job_id).proposal_ids[0]!).status,
    'pending',
  );
  assert.equal(core.catalog.list(scope).length, 0);
  await patchApproval(call, core, { allow_auto_create: true });
  const reviewedAgain = (await call('learning.refine', {
    session_ids: ['historical-session'],
  })) as Job;
  await core.tick();
  assert.equal(core.catalog.list(scope).length, 1);
  assert.equal(
    core.catalog.getProposal(scope, core.jobs.get(scope, reviewedAgain.job_id).proposal_ids[0]!)
      .status,
    'applied',
  );
  assert.equal(core.learning.candidates(scope).length, 1);
  assert.equal(core.store.all('proposals').length, 1);
  const afterPublication = (await call('learning.refine', {
    session_ids: ['historical-session'],
  })) as Job;
  await core.tick();
  assert.equal(core.jobs.get(scope, afterPublication.job_id).status, 'completed');
  assert.equal(core.catalog.list(scope).length, 1);
  assert.equal(core.store.all('proposals').length, 1);
});

test('duplicate targets in a model result cannot create competing proposals or duplicate skills', async (t) => {
  const { core, call } = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => ({
        output: {
          candidates: [
            candidate(job),
            candidate(job, { solution: 'A competing procedure for the same skill.' }),
          ],
        },
        cost_usd: 0,
      }),
    },
  });
  await patchApproval(call, core, { mode: 'auto', allow_auto_create: true });
  const job = (await call('learning.refine', { session_ids: ['historical-session'] })) as Job;
  await core.tick();
  assert.equal(core.jobs.get(scope, job.job_id).error?.code, 'validation_error');
  assert.equal(core.learning.candidates(scope).length, 0);
  assert.equal(core.store.all('proposals').length, 0);
  assert.equal(core.catalog.list(scope).length, 0);
});

test('low confidence knowledge does not publish even when auto-create is enabled', async (t) => {
  const { core, call } = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => ({
        output: { candidates: [candidate(job, { confidence: 0.5 })] },
        cost_usd: 0,
      }),
    },
  });
  await patchApproval(call, core, { mode: 'auto', allow_auto_create: true });
  const job = (await call('learning.refine', { session_ids: ['historical-session'] })) as Job;
  await core.tick();
  assert.equal(core.jobs.get(scope, job.job_id).status, 'completed');
  assert.equal(core.catalog.list(scope).length, 0);
  assert.equal(core.store.all('proposals').length, 0);
});

test('repeated review of an unchanged snapshot creates one candidate and proposal', async (t) => {
  const { core, call } = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => ({ output: { candidates: [candidate(job)] }, cost_usd: 0 }),
    },
  });
  for (let i = 0; i < 2; i++) {
    await call('learning.refine', { session_ids: ['historical-session'] });
    await core.tick();
  }
  assert.equal(core.learning.sessions(scope).length, 1);
  assert.equal(core.learning.candidates(scope).length, 1);
  assert.equal(core.store.all('proposals').length, 1);
});

test('refine enforces scope, role, pause, internal-session and empty/history constraints', async (t) => {
  let reads = 0;
  const { core, call } = fixture(t, {
    conversations: {
      ...history,
      read: async () => {
        reads++;
        return { content: '' };
      },
    },
    executors: { direct: async () => ({ output: { candidates: [] }, cost_usd: 0 }) },
  });
  await assert.rejects(
    call('learning.refine', {
      session_ids: ['historical-session'],
      scope: { workspace_id: 'foreign' },
    }),
    code('scope_violation'),
  );
  await assert.rejects(
    call(
      'learning.refine',
      { session_ids: ['historical-session'] },
      { ...owner, roles: ['viewer'] },
    ),
    code('forbidden'),
  );
  core.store.put('control', 'internal:internal-session', { internal: true });
  await assert.rejects(
    call('learning.refine', { session_ids: ['internal-session'] }),
    code('forbidden'),
  );
  assert.equal(reads, 0);
  await assert.rejects(call('learning.refine', { session_ids: [] }), code('validation_error'));
  await assert.rejects(
    call('learning.refine', { session_ids: ['historical-session', 'another'] }),
    code('validation_error'),
  );
  await call('system.pause', { subsystem: 'learning' });
  await assert.rejects(
    call('learning.refine', { session_ids: ['historical-session'] }),
    code('executor_unavailable'),
  );
  assert.equal(reads, 0);
  await call('system.resume', { subsystem: 'learning' });
  await assert.rejects(
    call('learning.refine', { session_ids: ['historical-session'] }),
    code('validation_error'),
  );
  assert.equal(core.learning.sessions(scope).length, 0);
  assert.equal(core.jobs.list(scope).length, 0);
});

test('external conversation review requires privacy opt-in and respects a later opt-out', async (t) => {
  const { core, call } = fixture(t, { conversations: history });
  await call('settings.patch', {
    expected_revision: 0,
    patch: { external_bridge: { enabled: true } },
  });
  await assert.rejects(
    call('learning.refine', {
      session_ids: ['historical-session'],
      execution: { mode: 'external' },
    }),
    code('forbidden'),
  );
  assert.equal(core.learning.sessions(scope).length, 0);
  await call('settings.patch', {
    expected_revision: 1,
    patch: { privacy: { send_raw_transcripts_to_external: true } },
  });
  const job = (await call('learning.refine', {
    session_ids: ['historical-session'],
    execution: { mode: 'external' },
  })) as Job;
  assert.equal(job.status, 'waiting_executor');
  assert.equal((core.modelPayload(job, true).snapshot as { content: string }).content, content);
  await call('settings.patch', {
    expected_revision: 2,
    patch: { privacy: { send_raw_transcripts_to_external: false } },
  });
  assert.throws(() => core.modelPayload(job, true), code('forbidden'));
});
