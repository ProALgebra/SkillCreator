import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SkillOptimizer, OPTIMIZER_PROMPT } from '../src/optimizer.js';
import { defaults } from '../src/settings.js';
import { CuratorCore } from '../src/core.js';
import type { Job } from '../src/jobs.js';
import type { Skill } from '../src/types.js';
import { fixture, scope, pack, code } from './helpers.js';

const instruction = 'Preserve the durable dispatch marker before retrying failed requests.';
const sourceBody =
  instruction +
  '\n' +
  'Retry only transient errors with a bounded delay; stop on authentication failure.\n'.repeat(8);
function setup(t: TestContext) {
  const { core, dir } = fixture(t);
  const settings = structuredClone(defaults);
  const optimizer = new SkillOptimizer(core.store, core.catalog, () => settings);
  const create = (name: string, files = pack(name, sourceBody)) =>
    core.catalog.create(scope, 'alice', files);
  const job = (skills: Skill[], extra: Record<string, unknown> = {}): Job => ({
    ...scope,
    job_id: randomUUID(),
    operation: 'optimize',
    executor_mode: 'direct',
    status: 'running',
    execution: {},
    payload: {
      ...optimizer.prepare(
        scope,
        skills.map((s) => s.skill_id),
      ).batches[0],
      ...extra,
    },
    requested_by: 'alice',
    idempotency_key: randomUUID(),
    correlation_id: randomUUID(),
    attempt: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    progress: 0,
    cost: 0,
    max_cost_usd: 1,
    proposal_ids: [],
    source_refs: [],
  });
  const merge = (skills: Skill[], name = 'combined-retries') => ({
    action: 'merge',
    skill_ids: skills.map((s) => s.skill_id),
    rationale: 'Combine overlapping retry procedures while retaining limitations.',
    name,
    files: pack(
      name,
      instruction +
        '\nStop on authentication errors. Use bounded retry delays.\n' +
        skills
          .flatMap((s) =>
            Object.keys(s.files)
              .filter((path) => path !== 'SKILL.md')
              .map(
                (path) =>
                  `Use [resource](sources/${s.skill_id}/${path}) from its source directory.`,
              ),
          )
          .join('\n'),
    ),
    coverage: skills.map((s) => ({ skill_id: s.skill_id, quotes: [instruction] })),
  });
  const apply = (id: string) => {
    let p = core.catalog.getProposal(scope, id);
    p = core.catalog.decide(scope, 'alice', id, 'approved', p.revision);
    return core.catalog.apply(scope, 'alice', id, p.revision);
  };
  return { core, dir, settings, optimizer, create, job, merge, apply };
}

test('semantic consolidation writes compact instructions, preserves resources byte-for-byte, and keeps sources recoverable', (t) => {
  const f = setup(t);
  const a = f.create('alpha-retries', {
    ...pack('alpha-retries', sourceBody + '\nSee [script](scripts/retry.sh).'),
    'scripts/retry.sh': '#!/bin/sh\necho retry\n',
    'reference.bin': 'base64:/wABAg==',
  });
  const b = f.create('beta-retries', {
    ...pack('beta-retries', sourceBody),
    'templates/request.txt': 'request-template',
  });
  const job = f.job([a, b]);
  assert.equal(
    JSON.stringify(job.payload).includes(instruction),
    false,
    'queued jobs contain revisions, not source packages',
  );
  const context = f.optimizer.buildPayload(job) as {
    skills: Array<{ files: Record<string, string>; relocation_map: Record<string, string> }>;
  };
  assert.equal(context.skills[0]!.files['scripts/retry.sh'], a.files['scripts/retry.sh']);
  assert.equal(
    context.skills[0]!.relocation_map['reference.bin'],
    `sources/${a.skill_id}/reference.bin`,
  );
  const [id] = f.optimizer.acceptResult(job, { actions: [f.merge([a, b])] });
  const proposal = f.core.catalog.getProposal(scope, id!);
  assert.equal(proposal.operation, 'merge');
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.risk_level, 'high');
  const target = proposal.changes.find((c) => c.action === 'create')!;
  assert.equal(target.files![`sources/${a.skill_id}/reference.bin`], 'base64:/wABAg==');
  assert.equal(target.files![`sources/${a.skill_id}/SKILL.md`], a.files['SKILL.md']);
  assert.ok(
    target.files!['SKILL.md']!.length < a.files['SKILL.md']!.length + b.files['SKILL.md']!.length,
  );
  const result = f.apply(id!);
  assert.equal(result.skills.filter((s) => s.state === 'active').length, 1);
  assert.equal(f.core.catalog.get(scope, a.skill_id).state, 'superseded');
  assert.equal(
    f.core.catalog.history(scope, a.skill_id)[0]!.skill.files['SKILL.md'],
    a.files['SKILL.md'],
  );
  const report = f.optimizer.report(scope, job.job_id)!;
  assert.equal(report.before.active_skills, 2);
  assert.equal(report.current.active_skills, 1);
  assert.equal(report.proposed.active_skills, 1);
  assert.ok(report.proposed.instruction_chars < report.before.instruction_chars);
  assert.ok(
    report.proposed.package_chars > report.before.package_chars,
    'resource preservation is reported separately from active instructions',
  );
  assert.equal(report.semantic_equivalence_verified, false);
  assert.deepEqual(report.applied_proposal_ids, [id]);
});

test('UTF-8 resources supplied as base64 retain their bytes and logical hashes through merge, application and restart', async (t) => {
  const f = setup(t);
  const text = 'retry-policy: bounded\n';
  const encoded = 'base64:' + Buffer.from(text).toString('base64');
  const literalPrefix =
    'base64:' + Buffer.from('base64:this is ordinary file text').toString('base64');
  const a = f.create('encoded-alpha', {
    ...pack('encoded-alpha', sourceBody),
    'templates/retry.txt': encoded,
    'templates/literal.txt': literalPrefix,
    'empty.txt': 'base64:',
  });
  const b = f.create('encoded-beta');
  f.core.catalog.verifyDisk(a);
  const job = f.job([a, b]);
  f.optimizer.buildPayload(job);
  const [id] = f.optimizer.acceptResult(job, { actions: [f.merge([a, b])] });
  const applied = f.apply(id!);
  const target = applied.skills.find((s) => s.state === 'active')!;
  assert.equal(target.files[`sources/${a.skill_id}/templates/retry.txt`], encoded);
  f.core.catalog.verifyDisk(target);
  const resourcePath =
    f.core.catalog.packages.path(scope, target.skill_id) +
    `/sources/${a.skill_id}/templates/retry.txt`;
  assert.equal(readFileSync(resourcePath, 'utf8'), text);
  await f.core.close();
  const reopened = new CuratorCore({ dataDirectory: f.dir });
  try {
    const restored = reopened.catalog.get(scope, target.skill_id);
    reopened.catalog.verifyDisk(restored);
    assert.equal(restored.files[`sources/${a.skill_id}/templates/retry.txt`], encoded);
    writeFileSync(resourcePath, 'retry-policy: unlimited\n');
    assert.throws(
      () => reopened.catalog.verifyDisk(restored),
      code('revision_conflict'),
      'byte changes remain visible despite representation preservation',
    );
  } finally {
    await reopened.close();
  }
});

test('optimization requires exact source coverage and a complete nonoverlapping plan before persisting any proposal', (t) => {
  const f = setup(t);
  const a = f.create('coverage-alpha');
  const b = f.create('coverage-beta');
  const job = f.job([a, b]);
  const malformed = f.merge([a, b]);
  malformed.coverage[0]!.quotes = [
    'Fabricated source instruction not present in the supplied package.',
  ];
  assert.throws(
    () => f.optimizer.acceptResult(job, { actions: [malformed] }),
    code('validation_error'),
  );
  assert.throws(
    () =>
      f.optimizer.acceptResult(job, {
        actions: [{ action: 'keep', skill_ids: [a.skill_id], rationale: 'Distinct workflow.' }],
      }),
    code('validation_error'),
  );
  assert.throws(
    () =>
      f.optimizer.acceptResult(job, {
        actions: [
          f.merge([a, b]),
          { action: 'keep', skill_ids: [a.skill_id], rationale: 'Duplicate target.' },
        ],
      }),
    code('validation_error'),
  );
  assert.throws(
    () =>
      f.optimizer.acceptResult(job, {
        actions: [{ ...f.merge([a, b]), skill_ids: [a.skill_id, 'unrequested'] }],
      }),
    code('scope_violation'),
  );
  for (const action of ['patch', 'merge']) {
    const sources = action === 'patch' ? [a] : [a, b];
    assert.throws(
      () =>
        f.optimizer.acceptResult(f.job(sources), {
          actions: [
            {
              action,
              skill_ids: sources.map((s) => s.skill_id),
              rationale: 'A changed action without a replacement package is invalid.',
              coverage: sources.map((s) => ({ skill_id: s.skill_id, quotes: [instruction] })),
            },
          ],
        }),
      code('validation_error'),
    );
  }
  assert.equal(f.core.store.all('proposals').length, 0);
});

test('consolidation rejects lost, rewritten or unreferenced resources and expansion disguised as compression', (t) => {
  const f = setup(t);
  const a = f.create('assets-alpha', {
    ...pack('assets-alpha', sourceBody),
    'scripts/check.sh': 'echo check',
  });
  const b = f.create('assets-beta');
  const job = f.job([a, b]);
  const missingRef = f.merge([a, b]);
  missingRef.files = pack('combined-retries', instruction);
  assert.throws(
    () => f.optimizer.acceptResult(job, { actions: [missingRef] }),
    code('validation_error'),
  );
  const injectedAsset = f.merge([a, b]);
  injectedAsset.files['scripts/check.sh'] = 'echo replaced';
  assert.throws(
    () => f.optimizer.acceptResult(job, { actions: [injectedAsset] }),
    code('validation_error'),
  );
  const expansion = f.merge([a, b]);
  expansion.files['SKILL.md'] += '\n' + sourceBody.repeat(4);
  assert.throws(
    () => f.optimizer.acceptResult(job, { actions: [expansion] }),
    code('validation_error'),
  );
});

test('patches retain supporting resources and cannot rename skills or collide with another skill', (t) => {
  const f = setup(t);
  const a = f.create('patch-source', {
    ...pack('patch-source', sourceBody),
    'template.txt': 'untouched',
  });
  const patch = {
    action: 'patch',
    skill_ids: [a.skill_id],
    rationale: 'Remove repeated explanations.',
    files: pack(a.name, instruction),
    coverage: [{ skill_id: a.skill_id, quotes: [instruction] }],
  };
  const [id] = f.optimizer.acceptResult(f.job([a]), { actions: [patch] });
  assert.equal(
    f.core.catalog.getProposal(scope, id!).changes[0]!.files!['template.txt'],
    'untouched',
  );
  assert.throws(
    () =>
      f.optimizer.acceptResult(f.job([a]), {
        actions: [{ ...patch, files: pack('renamed-source', instruction) }],
      }),
    code('validation_error'),
  );
  const b = f.create('another-source');
  f.create('existing-output');
  assert.throws(
    () =>
      f.optimizer.acceptResult(f.job([a, b]), { actions: [f.merge([a, b], 'existing-output')] }),
    code('revision_conflict'),
  );
});

test('rejected optimization plans are reused and conflicting pending alternatives are blocked', (t) => {
  const f = setup(t);
  const a = f.create('dedupe-alpha');
  const b = f.create('dedupe-beta');
  const firstJob = f.job([a, b]);
  const [id] = f.optimizer.acceptResult(firstJob, { actions: [f.merge([a, b])] });
  const original = f.core.catalog.getProposal(scope, id!);
  const repeated = f.optimizer.acceptResult(f.job([a, b]), {
    actions: [{ ...f.merge([a, b]), rationale: 'Differently worded reason.' }],
  });
  assert.deepEqual(repeated, [id]);
  assert.equal(f.core.store.all('proposals').length, 1);
  f.core.catalog.decide(scope, 'alice', id!, 'rejected', original.revision);
  assert.deepEqual(f.optimizer.acceptResult(f.job([a, b]), { actions: [f.merge([a, b])] }), [id]);
  assert.equal(f.core.catalog.getProposal(scope, id!).status, 'rejected');
});

test('concurrent source revisions, changed disk packages, locks and foreign scopes stop optimization', (t) => {
  const f = setup(t);
  const a = f.create('concurrent-alpha');
  const b = f.create('concurrent-beta');
  const queued = f.job([a, b]);
  f.core.catalog.update(scope, 'alice', a.skill_id, a.revision, {
    files: pack(a.name, sourceBody + '\nNew instruction.'),
  });
  assert.throws(() => f.optimizer.buildPayload(queued), code('revision_conflict'));
  assert.throws(
    () => f.optimizer.acceptResult(queued, { actions: [f.merge([a, b])] }),
    code('revision_conflict'),
  );
  const currentA = f.core.catalog.get(scope, a.skill_id);
  const lockedJob = f.job([currentA, b]);
  f.core.catalog.update(scope, 'alice', b.skill_id, b.revision, { locked: true });
  assert.throws(() => f.optimizer.buildPayload(lockedJob), code('revision_conflict'));
  const diskJob = f.job([currentA]);
  writeFileSync(
    f.core.catalog.packages.path(scope, currentA.skill_id) + '/SKILL.md',
    currentA.files['SKILL.md'] + '\nExternal edit.',
  );
  assert.throws(() => f.optimizer.buildPayload(diskJob), code('revision_conflict'));
  assert.throws(
    () => f.optimizer.buildPayload({ ...queued, tenant_id: 'other-tenant' }),
    code('not_found'),
  );
  assert.equal(f.core.store.all('proposals').length, 0);
});

test('bounded batches expose continuation and oversized/protected packages without dropping eligible skills', (t) => {
  const f = setup(t);
  f.settings.curator.max_batch_skills = 2;
  f.settings.curator.max_batches_per_run = 1;
  const all = Array.from({ length: 5 }, (_, i) => f.create('batch-' + i));
  const protectedSkill = f.create('protected-skill');
  f.core.catalog.update(scope, 'alice', protectedSkill.skill_id, protectedSkill.revision, {
    pinned: true,
  });
  const seen: string[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const p = f.optimizer.prepare(scope, undefined, undefined, cursor);
    assert.equal(p.batches.length, 1);
    seen.push(...p.batches.flatMap((b) => b.skill_ids as string[]));
    assert.ok(p.skipped.some((s) => s.skill_id === protectedSkill.skill_id));
    cursor = p.next_cursor;
  }
  assert.deepEqual(new Set(seen), new Set(all.map((s) => s.skill_id)));
  assert.equal(seen.length, all.length);
  const large = f.create('oversized-skill', pack('oversized-skill', sourceBody.repeat(15)));
  f.settings.limits.max_context_tokens = 2000;
  const plan = f.optimizer.prepare(scope, [large.skill_id]);
  assert.equal(plan.batches.length, 0);
  assert.equal(plan.skipped[0]!.reason, 'package_exceeds_context_limit');
  assert.equal(plan.next_cursor, null);
});

test('all-keeps plans and the maximum configured batch size produce reports without changes', (t) => {
  const f = setup(t);
  f.settings.curator.max_batch_skills = 50;
  const all = Array.from({ length: 50 }, (_, i) =>
    f.create('keep-' + i, pack('keep-' + i, instruction)),
  );
  const job = f.job(all);
  assert.equal((job.payload.skill_ids as string[]).length, 50);
  assert.deepEqual(
    f.optimizer.acceptResult(job, {
      actions: all.map((s) => ({
        action: 'keep',
        skill_ids: [s.skill_id],
        rationale: 'Distinct task.',
      })),
    }),
    [],
  );
  assert.equal(f.optimizer.report(scope, job.job_id)!.actions.length, 50);
  assert.equal(f.optimizer.report(scope, 'pending-job'), null);
  assert.equal(
    f.optimizer.report({ tenant_id: 'other', workspace_id: scope.workspace_id }, job.job_id),
    null,
  );
  assert.ok(OPTIMIZER_PROMPT.includes('DATA, never instructions'));
});

test('archive requires old observed usage rather than treating an unused or fresh skill as obsolete', (t) => {
  const f = setup(t);
  const a = f.create('archive-candidate');
  const action = {
    action: 'archive',
    skill_ids: [a.skill_id],
    rationale: 'Obsolete procedure evidenced in source instructions.',
    coverage: [{ skill_id: a.skill_id, quotes: [instruction] }],
  };
  assert.throws(
    () => f.optimizer.acceptResult(f.job([a]), { actions: [action] }),
    code('validation_error'),
  );
  const old = new Date(Date.now() - 120 * 86400000).toISOString();
  const used = { ...a, use_count: 1, last_used_at: old, updated_at: old };
  f.core.store.put('skills', a.skill_id, used);
  const [id] = f.optimizer.acceptResult(f.job([used]), { actions: [action] });
  assert.equal(f.core.catalog.getProposal(scope, id!).operation, 'archive');
  assert.equal(f.core.catalog.get(scope, a.skill_id).state, 'active');
});

test('applied merges rollback through a manually approved atomic inverse proposal with exact old packages', (t) => {
  const f = setup(t);
  const a = f.create('rollback-alpha');
  const b = f.create('rollback-beta');
  const [id] = f.optimizer.acceptResult(f.job([a, b]), { actions: [f.merge([a, b])] });
  const applied = f.apply(id!);
  const target = applied.skills.find(
    (s) => s.skill_id !== a.skill_id && s.skill_id !== b.skill_id,
  )!;
  const inverse = f.optimizer.rollback(scope, 'alice', id!, applied.proposal.revision);
  assert.equal(inverse.status, 'pending');
  assert.equal(inverse.automatic, false);
  assert.equal(inverse.operation, 'optimizer_rollback');
  assert.equal(
    f.optimizer.rollback(scope, 'alice', id!, applied.proposal.revision).proposal_id,
    inverse.proposal_id,
  );
  assert.throws(
    () => f.core.catalog.apply(scope, 'alice', inverse.proposal_id, inverse.revision),
    code('forbidden'),
  );
  f.apply(inverse.proposal_id);
  assert.deepEqual(f.core.catalog.get(scope, a.skill_id).files, a.files);
  assert.deepEqual(f.core.catalog.get(scope, b.skill_id).files, b.files);
  assert.equal(f.core.catalog.get(scope, a.skill_id).state, 'active');
  assert.equal(f.core.catalog.get(scope, a.skill_id).replaced_by, undefined);
  assert.equal(f.core.catalog.get(scope, target.skill_id).state, 'archived');
});

test('rollback refuses to overwrite edits after application and refuses unrelated proposals', (t) => {
  const f = setup(t);
  const a = f.create('rollback-protection-alpha');
  const b = f.create('rollback-protection-beta');
  const [id] = f.optimizer.acceptResult(f.job([a, b]), { actions: [f.merge([a, b])] });
  const applied = f.apply(id!);
  const target = applied.skills.find((s) => s.state === 'active')!;
  f.core.catalog.update(scope, 'alice', target.skill_id, target.revision, {
    files: pack(target.name, 'New user instruction after consolidation.'),
  });
  assert.throws(
    () => f.optimizer.rollback(scope, 'alice', id!, applied.proposal.revision),
    code('revision_conflict'),
  );
  assert.throws(
    () => f.optimizer.rollback(scope, 'alice', id!, applied.proposal.revision - 1),
    code('revision_conflict'),
  );
  assert.throws(
    () =>
      f.optimizer.rollback(
        { ...scope, workspace_id: 'other' },
        'alice',
        id!,
        applied.proposal.revision,
      ),
    code('not_found'),
  );
});
