import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, owner, code, pack } from './helpers.js';
import { tables } from '../src/store.js';
import type { Job } from '../src/jobs.js';
import type { Principal, Settings, Skill } from '../src/types.js';
import type { RpcInput } from '../src/rpc.js';
import { outputSchemas } from '../src/rpc.js';

type SettingsResponse = { revision: number; settings: Settings };
const evidence = 'The integration test passed after preserving the dispatch marker.';
const conversation = {
  list: async () => [{ session_id: 'publication-review', title: 'Dispatch retries' }],
  read: async () => ({ content: 'user: Preserve the marker before retrying.\ntool: ' + evidence }),
};
function candidate(job: Job, name: string, target?: Skill) {
  return {
    name,
    ...(target ? { target_skill_id: target.skill_id } : {}),
    title: 'Preserve dispatch markers',
    problem: 'Transient failures can duplicate ' + name + ' requests.',
    solution: target
      ? 'Keep the dispatch marker until the remote result has been durably recorded.'
      : 'Persist a durable dispatch marker before retrying and bound the retry count.',
    conditions: ['Transient request failure'],
    evidence: [evidence],
    failures: [],
    confidence: 0.95,
    reusability_score: 0.9,
    source_refs: job.source_refs,
  };
}

test('publication mode is manual by default and its switch preserves independent safety and archive settings', async (t) => {
  const { call } = fixture(t);
  const initial = (await call('settings.get')) as SettingsResponse;
  assert.equal(initial.settings.approval.mode, 'manual');
  assert.equal(initial.settings.approval.allow_auto_create, false);
  assert.equal(initial.settings.approval.allow_auto_patch_managed_low_risk, false);
  await call('settings.patch', {
    expected_revision: 0,
    patch: { approval: { allow_auto_archive_managed: true }, limits: { daily_cost_usd: 1.75 } },
  });
  const automatic = (await call('settings.set_publication_mode', {
    publication_mode: 'auto',
    expected_revision: 1,
  })) as SettingsResponse;
  assert.equal(outputSchemas['settings.set_publication_mode'].safeParse(automatic).success, true);
  assert.equal(automatic.revision, 2);
  assert.deepEqual(automatic.settings.approval, {
    mode: 'auto',
    allow_auto_create: true,
    allow_auto_merge: false,
    allow_auto_patch_managed_low_risk: true,
    allow_auto_archive_managed: true,
    protect_manual_skills: true,
  });
  assert.equal(automatic.settings.limits.daily_cost_usd, 1.75);
  const manual = (await call('settings.set_publication_mode', {
    publication_mode: 'manual',
    expected_revision: 2,
  })) as SettingsResponse;
  assert.equal(outputSchemas['settings.set_publication_mode'].safeParse(manual).success, true);
  assert.equal(manual.revision, 3);
  assert.deepEqual(manual.settings.approval, {
    mode: 'manual',
    allow_auto_create: false,
    allow_auto_merge: false,
    allow_auto_patch_managed_low_risk: false,
    allow_auto_archive_managed: true,
    protect_manual_skills: true,
  });
  assert.equal(manual.settings.limits.daily_cost_usd, 1.75);
});

test('the publication switch publishes new conversation skills and managed updates, then manual mode leaves new results pending', async (t) => {
  let name = 'automatic-dispatch-retries';
  let target: Skill | undefined;
  const { core, call } = fixture(t, {
    conversations: conversation,
    executors: {
      direct: async ({ job }) => ({
        output: { candidates: [candidate(job, name, target)] },
        cost_usd: 0,
      }),
    },
  });
  await call('settings.set_publication_mode', { publication_mode: 'auto', expected_revision: 0 });
  const runReview = async () => {
    const queued = (await call('learning.refine', {
      session_ids: ['publication-review'],
      execution: { mode: 'direct' },
    })) as Job;
    await core.tick();
    const job = core.jobs.get(scope, queued.job_id);
    assert.equal(job.status, 'completed');
    assert.equal(job.proposal_ids.length, 1);
    return core.catalog.getProposal(scope, job.proposal_ids[0]!);
  };
  assert.equal((await runReview()).status, 'applied');
  target = core.catalog.list(scope)[0]!;
  assert.equal(target.name, name);
  const originalRevision = target.revision;
  assert.equal((await runReview()).status, 'applied');
  assert.equal(core.catalog.get(scope, target.skill_id).revision, originalRevision + 1);
  assert.equal(core.catalog.list(scope).length, 1);
  await call('settings.set_publication_mode', { publication_mode: 'manual', expected_revision: 1 });
  target = undefined;
  name = 'manual-dispatch-retries';
  const pending = await runReview();
  assert.equal(pending.status, 'pending');
  assert.equal(core.catalog.list(scope).length, 1);
  await call('settings.set_publication_mode', { publication_mode: 'auto', expected_revision: 2 });
  assert.equal(core.catalog.getProposal(scope, pending.proposal_id).status, 'pending');
  assert.equal(core.catalog.list(scope).length, 1, 'Changing policy does not apply old proposals');
});

test('automatic publication still protects manual, pinned, locked and readonly skills', async (t) => {
  let target!: Skill;
  const { core, call } = fixture(t, {
    conversations: conversation,
    executors: {
      direct: async ({ job }) => ({
        output: { candidates: [candidate(job, target.name, target)] },
        cost_usd: 0,
      }),
    },
  });
  await call('settings.set_publication_mode', { publication_mode: 'auto', expected_revision: 0 });
  for (const [index, protection] of [
    { management_policy: 'manual' as const },
    { pinned: true },
    { locked: true },
    { management_policy: 'readonly' as const },
  ].entries()) {
    const created = (await call('skills.create', {
      files: pack('protected-publication-' + index),
    })) as Skill;
    target = { ...created, ...protection };
    core.store.put('skills', target.skill_id, target);
    const job = (await call('learning.refine', { session_ids: ['publication-review'] })) as Job;
    await core.tick();
    assert.equal(core.jobs.get(scope, job.job_id).error?.code, 'scope_violation');
    assert.deepEqual(core.catalog.get(scope, target.skill_id), target);
  }
  assert.equal(core.store.all('proposals').length, 0);
  assert.equal(core.learning.candidates(scope).length, 0);
});

test('publication mode updates are revision checked and idempotent without repeated audit writes', async (t) => {
  const { core, call } = fixture(t);
  const input = {
    publication_mode: 'auto' as const,
    expected_revision: 0,
    idempotency_key: 'publication-mode-once',
  };
  const first = await call('settings.set_publication_mode', input);
  const eventsBeforeReplay = core.store.all('events');
  assert.deepEqual(await call('settings.set_publication_mode', input), first);
  assert.deepEqual(core.store.all('events'), eventsBeforeReplay);
  assert.equal(core.settings.get(scope).revision, 1);
  await assert.rejects(
    call('settings.set_publication_mode', { ...input, publication_mode: 'manual' }),
    code('idempotency_conflict'),
  );
  await assert.rejects(
    call('settings.set_publication_mode', { publication_mode: 'manual', expected_revision: 0 }),
    code('revision_conflict'),
  );
  assert.equal(core.settings.get(scope).settings.approval.mode, 'auto');
  assert.equal(core.settings.get(scope).revision, 1);
});

test('publication mode previews persist no settings, idempotency records, events or audit entries', async (t) => {
  const { core, call } = fixture(t);
  const snapshot = () => Object.fromEntries(tables.map((table) => [table, core.store.all(table)]));
  const before = snapshot();
  const preview = (await call('settings.set_publication_mode', {
    publication_mode: 'auto',
    expected_revision: 0,
    dry_run: true,
    idempotency_key: 'publication-preview',
  })) as SettingsResponse & { status: string };
  assert.equal(outputSchemas['settings.set_publication_mode'].safeParse(preview).success, true);
  assert.equal(preview.status, 'dry_run');
  assert.equal(preview.settings.approval.mode, 'auto');
  assert.equal(preview.settings.approval.allow_auto_create, true);
  assert.equal(preview.settings.approval.allow_auto_patch_managed_low_risk, true);
  assert.deepEqual(snapshot(), before);
  assert.equal(core.settings.get(scope).settings.approval.mode, 'manual');
});

test('publication mode rejects absent or invalid modes and missing mutation prerequisites', async (t) => {
  const { core, call } = fixture(t);
  for (const input of [
    { expected_revision: 0 },
    { publication_mode: 'safe', expected_revision: 0 },
    { publication_mode: true, expected_revision: 0 },
    { publication_mode: 'auto' },
  ])
    await assert.rejects(
      call('settings.set_publication_mode', input as RpcInput),
      code('validation_error'),
    );
  await assert.rejects(
    core.call(
      'settings.set_publication_mode',
      { publication_mode: 'auto', expected_revision: 0 },
      owner,
    ),
    code('validation_error'),
  );
  assert.equal(core.settings.get(scope).revision, 0);
  assert.equal(core.settings.get(scope).settings.approval.mode, 'manual');
});

test('only administrators may switch publication and their requests stay within authorized tenant, workspace and global scope', async (t) => {
  const { core, call } = fixture(t);
  const input = { publication_mode: 'auto' as const, expected_revision: 0 };
  for (const role of ['viewer', 'editor', 'curator', 'worker'] as const)
    await assert.rejects(
      call('settings.set_publication_mode', input, { ...owner, roles: [role] }),
      code('forbidden'),
    );
  for (const requestedScope of [
    { tenant_id: 'another-tenant' },
    { workspace_id: 'another-workspace' },
  ])
    await assert.rejects(
      call('settings.set_publication_mode', { ...input, scope: requestedScope }),
      code('scope_violation'),
    );
  await assert.rejects(
    call('settings.set_publication_mode', { ...input, settings_level: 'global' }),
    code('forbidden'),
  );
  assert.equal(core.store.all('settings').length, 0);
  assert.equal(core.store.all('events').length, 0);
});

test('publication mode follows global, tenant and workspace inheritance without changing neighboring overrides', async (t) => {
  const { call } = fixture(t);
  const globalAdmin: Principal = { ...owner, global_admin: true };
  const neighboring: Principal = { ...owner, workspace_ids: ['neighbor-workspace'] };
  const anotherTenant: Principal = {
    ...owner,
    tenant_id: 'another-tenant',
    workspace_ids: ['other-workspace'],
  };
  await call(
    'settings.set_publication_mode',
    {
      publication_mode: 'auto',
      expected_revision: 0,
      settings_level: 'global',
    },
    globalAdmin,
  );
  assert.equal(
    ((await call('settings.get', {}, anotherTenant)) as SettingsResponse).settings.approval.mode,
    'auto',
  );
  await call('settings.set_publication_mode', {
    publication_mode: 'manual',
    expected_revision: 0,
    settings_level: 'tenant',
  });
  assert.equal(
    ((await call('settings.get', {}, neighboring)) as SettingsResponse).settings.approval.mode,
    'manual',
  );
  await call('settings.set_publication_mode', { publication_mode: 'auto', expected_revision: 0 });
  assert.equal(((await call('settings.get')) as SettingsResponse).settings.approval.mode, 'auto');
  assert.equal(
    ((await call('settings.get', {}, neighboring)) as SettingsResponse).settings.approval.mode,
    'manual',
  );
  assert.equal(
    ((await call('settings.get', {}, anotherTenant)) as SettingsResponse).settings.approval.mode,
    'auto',
  );
  await call('settings.set_publication_mode', { publication_mode: 'manual', expected_revision: 1 });
  const local = (await call('settings.get')) as SettingsResponse;
  assert.equal(local.settings.approval.mode, 'manual');
  assert.equal(local.settings.approval.allow_auto_create, false);
  assert.equal(local.settings.approval.allow_auto_patch_managed_low_risk, false);
  assert.equal(local.settings.approval.protect_manual_skills, true);
});
