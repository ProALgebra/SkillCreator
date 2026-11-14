// Explicit live check. Only dedicated temporary skills and their proposals are changed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { SkillCurator } from '../dist/rpc.js';
import { resolveLocalToken } from '../dist/auth.js';

const endpoint = await Service.discover();
assert.ok(endpoint, 'Start the OpenCode service');
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const rpc = client.rpc(SkillCurator);
const auth = resolveLocalToken({ local_service_auth: true });
const location = { directory: process.cwd() };
const call = (method, input = {}) =>
  rpc[method]({ ...input, auth }, { location, signal: AbortSignal.timeout(20000) });
const mutate = (method, input = {}) => call(method, { ...input, idempotency_key: randomUUID() });
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i < 0 ? fallback : process.argv[i + 1];
};
const settings = await call('settings.get');
assert.equal(
  settings.settings.approval.mode,
  'manual',
  'Use manual approval for this controlled check',
);
const sources = [];
const proposals = new Set();
const targets = new Set();
let job;
try {
  const stamp = Date.now();
  const procedure =
    'Record the dispatch marker before a network retry. Stop on authentication errors. Retry only known transient failures, with bounded delays. Keep the marker until the remote outcome is durably recorded.\n';
  for (const suffix of ['a', 'b']) {
    const name = 'curator-opt-check-' + suffix + '-' + stamp;
    const files = {
      'SKILL.md': `---\nname: ${name}\ndescription: Retry policy for remote dispatches with a durable marker and bounded transient retries.\n---\n\n# Dispatch retries\n\n${procedure.repeat(8)}\n[Validation checklist](references/checks.md)\n`,
      'references/checks.md':
        'Check the marker is recorded before dispatch and authentication failures stop retries.\n',
    };
    sources.push(await mutate('skills.create', { files }));
  }
  const preview = await call('curator.optimize', {
    skill_ids: sources.map((s) => s.skill_id),
    dry_run: true,
  });
  assert.equal(preview.files_written, false);
  assert.equal(preview.batches.length, 1);
  const run = await mutate('curator.optimize', {
    skill_ids: sources.map((s) => s.skill_id),
    reason:
      'These two controlled test skills contain the same repeated retry procedure. Consolidate the repetition into one coherent concise skill, preserving its stop conditions and references. Use literal source instruction quotes as coverage.',
    execution: {
      mode: arg('--mode', 'direct'),
      provider: arg('--provider', 'deepseek'),
      model: arg('--model-id', 'deepseek-flash'),
      max_cost_usd: 0.01,
      timeout_sec: 90,
    },
  });
  assert.equal(run.jobs.length, 1);
  job = run.jobs[0];
  const deadline = Date.now() + 105000;
  while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    job = await call('jobs.get', { job_id: job.job_id });
  }
  console.log(
    'Optimizer:',
    JSON.stringify({
      job_id: job.job_id,
      status: job.status,
      proposal_count: job.proposal_ids.length,
      error: job.error,
    }),
  );
  assert.equal(job.status, 'completed');
  const values = [];
  for (const id of job.proposal_ids) {
    proposals.add(id);
    const p = await call('proposals.get', { proposal_id: id });
    for (const c of p.changes) if (c.action === 'create') targets.add(c.skill_id);
    values.push(p);
  }
  const merge = values.find((p) => p.operation === 'merge');
  if (process.argv.includes('--require-merge'))
    assert.ok(merge, 'Model did not propose consolidation');
  if (merge) {
    let p = await mutate('proposals.approve', {
      proposal_id: merge.proposal_id,
      expected_revision: merge.revision,
    });
    const applied = await mutate('proposals.apply', {
      proposal_id: p.proposal_id,
      expected_revision: p.revision,
    });
    const created = applied.skills.find((s) => targets.has(s.skill_id));
    assert.ok(created);
    assert.ok(
      created.files['SKILL.md'].length <
        sources.reduce((n, s) => n + s.files['SKILL.md'].length, 0),
    );
    for (const s of sources) {
      assert.equal((await call('skills.get', { skill_id: s.skill_id })).state, 'superseded');
      assert.equal(
        created.files['sources/' + s.skill_id + '/references/checks.md'],
        s.files['references/checks.md'],
      );
    }
    p = await call('proposals.get', { proposal_id: p.proposal_id });
    const inverse = await mutate('curator.rollback', {
      proposal_id: p.proposal_id,
      expected_revision: p.revision,
    });
    proposals.add(inverse.proposal_id);
    assert.equal(inverse.status, 'pending');
    const approved = await mutate('proposals.approve', {
      proposal_id: inverse.proposal_id,
      expected_revision: inverse.revision,
    });
    await mutate('proposals.apply', {
      proposal_id: approved.proposal_id,
      expected_revision: approved.revision,
    });
    for (const s of sources) {
      const restored = await call('skills.get', { skill_id: s.skill_id });
      assert.equal(restored.state, 'active');
      assert.deepEqual(restored.files, s.files);
    }
    console.log(
      'Semantic merge, compact instructions, preserved resources, and approved rollback passed',
    );
  }
  const status = await call('curator.status');
  assert.ok(status.reports.some((r) => r.job_id === job.job_id));
  console.log('Curator reports and native RPC passed');
} finally {
  if (job) {
    const latest = await call('jobs.get', { job_id: job.job_id });
    for (const id of latest.proposal_ids) proposals.add(id);
  }
  for (const id of proposals) {
    const p = await call('proposals.get', { proposal_id: id });
    for (const c of p.changes) if (c.action === 'create') targets.add(c.skill_id);
    if (['pending', 'approved'].includes(p.status))
      await mutate('proposals.cancel', { proposal_id: id, expected_revision: p.revision });
  }
  for (const id of [...sources.map((s) => s.skill_id), ...targets]) {
    const s = await call('skills.get', { skill_id: id }).catch(() => null);
    if (s && s.state !== 'archived')
      await mutate('skills.archive', { skill_id: id, expected_revision: s.revision });
  }
  console.log('Temporary optimizer skills archived; audit retained');
}
