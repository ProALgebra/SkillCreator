import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, code, pack } from './helpers.js';
import type { CuratorCore } from '../src/core.js';
import type { Job } from '../src/jobs.js';
import type { Skill } from '../src/types.js';
import { contextCharLimit } from '../src/context.js';

const early = 'The initial run appeared successful.';
const correction = 'The final test failed; the earlier success was retracted.';
const corrected = 'The bounded retry integration test passed after preserving the marker.';
const long = [
  early,
  ...Array.from(
    { length: 160 },
    (_, n) =>
      `Stage ${n}: investigate the independent retry conditions. ` +
      'A routine diagnostic line. '.repeat(20),
  ),
  correction,
  corrected,
].join('\n\n');
const history = { list: async () => [], read: async () => ({ content: long }) };

function candidate(job: Job, quote: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'durable-retries',
    title: 'Durable retries',
    problem: 'Retrying remote requests can duplicate dispatches.',
    solution: 'Persist the dispatch marker before a bounded retry.',
    conditions: ['Transient network failure'],
    evidence: [quote],
    failures: [],
    confidence: 0.9,
    reusability_score: 0.9,
    source_refs: job.source_refs,
    ...extra,
  };
}
type Observation = { text: string; evidence: string[]; source_refs: string[] };
type Input = { candidates: ReturnType<typeof candidate>[]; observations: Observation[] };

test('multipart review retains the middle, reconciles late corrections and only then creates proposals', async (t) => {
  let core!: CuratorCore;
  let extracted = 0;
  let finalSawCorrection = false;
  const f = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => {
        const context = core.modelPayload(job);
        assert.ok(
          JSON.stringify(context).length <=
            contextCharLimit(core.settings.get(scope).settings, job.execution),
        );
        if (job.payload.analysis_phase === 'extract') {
          extracted++;
          assert.equal(core.store.all('proposals').length, 0);
          assert.equal(
            core.learning.sessions(scope).some((s) => s.processed),
            false,
          );
          const text = (context.snapshot as { content: string }).content;
          const observations = [early, correction, corrected]
            .filter((quote) => text.includes(quote))
            .map((quote) => ({ text: quote, evidence: [quote], source_refs: job.source_refs }));
          const candidates = text.includes(early)
            ? [candidate(job, early, { solution: 'An early, subsequently invalidated procedure.' })]
            : [];
          return { output: { candidates, observations }, cost_usd: 0.001 };
        }
        const inputs = context.inputs as Input[];
        const observations = inputs.flatMap((i) => i.observations);
        if (job.payload.analysis_phase === 'reduce')
          return { output: { candidates: [], observations }, cost_usd: 0.001 };
        finalSawCorrection = observations.some((o) => o.evidence.includes(correction));
        const success = observations.find((o) => o.evidence.includes(corrected))!;
        return {
          output: { candidates: [candidate(job, corrected, { source_refs: success.source_refs })] },
          cost_usd: 0.001,
        };
      },
    },
  });
  core = f.core;
  await f.call('settings.patch', {
    expected_revision: 0,
    patch: { limits: { max_context_tokens: 8000 } },
  });
  const preview = (await f.call('learning.refine', {
    session_ids: ['long-session'],
    dry_run: true,
  })) as { parts_total: number; truncated: boolean };
  assert.ok(preview.parts_total > 1);
  assert.equal(preview.truncated, false);
  assert.equal(core.store.all('sessions').length, 0);
  const parent = (await f.call('learning.refine', { session_ids: ['long-session'] })) as Job;
  assert.equal(parent.status, 'waiting_parts');
  assert.equal(parent.attempt, 0);
  assert.ok(core.learning.sessions(scope).some((s) => s.content === long));
  assert.equal(JSON.stringify(core.store.all('jobs')).includes(early), false);
  await core.tick();
  const done = core.jobs.get(scope, parent.job_id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.ok(extracted > 1);
  assert.equal(finalSawCorrection, true);
  assert.equal(done.proposal_ids.length, 1);
  assert.equal(
    core.learning.sessions(scope).every((s) => s.processed),
    true,
  );
  const proposal = core.catalog.getProposal(scope, done.proposal_ids[0]!);
  assert.match(proposal.changes[0]!.files!['SKILL.md']!, /Persist the dispatch marker/);
  assert.equal(JSON.stringify(proposal).includes('An early, subsequently'), false);
  const status = (await f.call('jobs.progress', { job_id: parent.job_id })) as {
    progress: number;
    analysis: {
      cost_usd: number;
      budget_total: number;
      parts_completed: number;
      parts_total: number;
    };
  };
  assert.equal(status.progress, 1);
  assert.equal(status.analysis.parts_completed, status.analysis.parts_total);
  assert.ok(status.analysis.cost_usd <= status.analysis.budget_total);
});

test('invalid part results preserve progress and explicit parent retry redoes only the failed part', async (t) => {
  let core!: CuratorCore;
  let fail = true;
  const executions = new Map<number, number>();
  const f = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => {
        core.modelPayload(job);
        const index = job.payload.part_index as number;
        if (job.payload.analysis_phase === 'extract') {
          executions.set(index, (executions.get(index) ?? 0) + 1);
          if (index === 1 && fail) {
            fail = false;
            return { output: { unexpected: true }, cost_usd: 0 };
          }
          return { output: { candidates: [], observations: [] }, cost_usd: 0 };
        }
        return { output: { candidates: [] }, cost_usd: 0 };
      },
    },
  });
  core = f.core;
  await f.call('settings.patch', {
    expected_revision: 0,
    patch: { limits: { max_context_tokens: 8000 } },
  });
  const parent = (await f.call('learning.refine', { session_ids: ['long-session'] })) as Job;
  await core.tick();
  assert.equal(core.jobs.get(scope, parent.job_id).status, 'failed');
  assert.equal(executions.get(0), 1);
  assert.equal(
    core.learning.sessions(scope).some((s) => s.processed),
    false,
  );
  await f.call('jobs.retry', { job_id: parent.job_id });
  await core.tick();
  assert.equal(core.jobs.get(scope, parent.job_id).status, 'completed');
  assert.equal(executions.get(0), 1);
  assert.equal(executions.get(1), 2);
  assert.equal(
    core.learning.sessions(scope).every((s) => s.processed),
    true,
  );
});

test('final reconciliation cannot cite a source quotation omitted from its intermediate evidence', async (t) => {
  let core!: CuratorCore;
  const f = fixture(t, {
    conversations: history,
    executors: {
      direct: async ({ job }) => {
        const context = core.modelPayload(job);
        if (job.payload.analysis_phase === 'extract')
          return { output: { candidates: [], observations: [] }, cost_usd: 0 };
        const source = core.learning
          .sessions(scope)
          .find((s) => job.source_refs.includes(s.id) && s.content.includes(corrected))!;
        return {
          output: { candidates: [candidate(job, corrected, { source_refs: [source.id] })] },
          cost_usd: 0,
        };
      },
    },
  });
  core = f.core;
  await f.call('settings.patch', {
    expected_revision: 0,
    patch: { limits: { max_context_tokens: 8000 } },
  });
  const parent = (await f.call('learning.refine', { session_ids: ['long-session'] })) as Job;
  await core.tick();
  assert.equal(core.jobs.get(scope, parent.job_id).status, 'failed');
  assert.equal(core.jobs.get(scope, parent.job_id).error?.code, 'validation_error');
  assert.equal(core.store.all('proposals').length, 0);
  assert.equal(
    core.learning.sessions(scope).some((s) => s.processed),
    false,
  );
});

test('call and retained-source caps reject before any paid job, and relevance selects useful catalog context', async (t) => {
  const f = fixture(t, {
    conversations: history,
    executors: { direct: async () => ({ output: { candidates: [] }, cost_usd: 0 }) },
  });
  await f.call('settings.patch', {
    expected_revision: 0,
    patch: { limits: { max_context_tokens: 8000 }, analysis: { max_calls: 2 } },
  });
  await assert.rejects(
    f.call('learning.refine', { session_ids: ['long-session'] }),
    code('budget_exceeded'),
  );
  assert.equal(f.core.store.all('jobs').length, 0);
  assert.equal(f.core.store.all('sessions').length, 0);
  for (let n = 0; n < 12; n++)
    await f.call('skills.create', {
      files: pack(`alphabetic-unrelated-${n}`, 'Unrelated deployment instructions. '.repeat(30)),
    });
  const relevant = (await f.call('skills.create', {
    files: pack('zzzz-durable-retry', 'Retry request dispatch marker conditions.'),
  })) as Skill;
  const prepared = f.core.conversationReview.prepare(
    scope,
    'selected',
    'Use zzzz-durable-retry for retry request dispatch markers.',
  );
  assert.equal(prepared.payload.skill_ids[0], relevant.skill_id);
  assert.throws(
    () => f.core.conversationReview.prepare(scope, 'oversized', 'x'.repeat(2_000_001)),
    code('budget_exceeded'),
  );
});

test('large intermediate analyses use bounded reductions and preserve progress under the same budget', async (t) => {
  let core!: CuratorCore;
  let reductions = 0;
  const quote = 'Routine diagnostics were inconclusive.';
  const f = fixture(t, {
    conversations: {
      ...history,
      read: async () => ({
        content: (quote + '\n' + 'Inspect the dispatch marker. '.repeat(20) + '\n\n').repeat(500),
      }),
    },
    executors: {
      direct: async ({ job }) => {
        const context = core.modelPayload(job);
        assert.ok(
          JSON.stringify(context).length <=
            contextCharLimit(core.settings.get(scope).settings, job.execution),
        );
        if (job.payload.analysis_phase === 'extract') {
          const limit = context.result_char_limit as number;
          const note = {
            text: 'Inconclusive diagnostics. '.repeat(Math.floor((limit - 450) / 25)),
            evidence: [quote],
            source_refs: job.source_refs,
          };
          return { output: { candidates: [], observations: [note] }, cost_usd: 0.001 };
        }
        if (job.payload.analysis_phase === 'reduce') {
          reductions++;
          const first = (context.inputs as Input[])[0]!.observations[0]!;
          return {
            output: {
              candidates: [],
              observations: [
                {
                  ...first,
                  text: 'Repeated inconclusive diagnostics; no demonstrated successful procedure.',
                },
              ],
            },
            cost_usd: 0.001,
          };
        }
        return { output: { candidates: [] }, cost_usd: 0.001 };
      },
    },
  });
  core = f.core;
  await f.call('settings.patch', {
    expected_revision: 0,
    patch: { limits: { max_context_tokens: 8000 } },
  });
  const parent = (await f.call('learning.refine', { session_ids: ['large-analysis'] })) as Job;
  await core.tick();
  const done = core.jobs.get(scope, parent.job_id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.ok(reductions > 0);
  const status = core.analysis.status(done)!;
  assert.ok(status.cost_usd <= status.budget_total);
  assert.ok(status.calls_used <= status.max_calls);
  assert.equal(
    core.learning.sessions(scope).every((s) => s.processed),
    true,
  );
  assert.equal(core.store.all('proposals').length, 0);
});
