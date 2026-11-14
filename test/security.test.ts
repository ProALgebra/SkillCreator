import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, pack, owner, scope, code } from './helpers.js';
import type { Skill, Principal } from '../src/types.js';
import { methodNames, SkillCurator, inputSchema } from '../src/rpc.js';
import { settingsSchema, defaults } from '../src/settings.js';
import { redact, containsSecrets, deterministicReview } from '../src/learning.js';

test('tenant and workspace isolation protects every resource by known ID', async (t) => {
  const { call } = fixture(t);
  const a = (await call('skills.create', { files: pack('private') })) as Skill;
  const other: Principal = { ...owner, subject: 'bob', tenant_id: 'tenant-b' };
  await assert.rejects(call('skills.get', { skill_id: a.skill_id }, other), code('not_found'));
  await assert.rejects(
    call('skills.get', { skill_id: a.skill_id, scope: { tenant_id: owner.tenant_id } }, other),
    code('scope_violation'),
  );
  await assert.rejects(
    call('skills.get', { skill_id: a.skill_id, scope: { workspace_id: 'unowned' } }),
    code('scope_violation'),
  );
  const events = (await call('events.replay', {}, other)) as { items: unknown[] };
  assert.equal(events.items.length, 0);
});
test('viewer and worker cannot approve, publish, or patch settings', async (t) => {
  const { call } = fixture(t);
  for (const roles of [['viewer'], ['worker']] as Principal['roles'][])
    for (const method of [
      'skills.create',
      'proposals.approve',
      'proposals.apply',
      'settings.patch',
    ] as const)
      await assert.rejects(
        call(method, { files: pack('forbidden') }, { ...owner, roles }),
        code('forbidden'),
      );
});
test('all specified RPC methods are registered; schema rejects unknown fields', () => {
  assert.equal(methodNames.length, 80);
  for (const name of methodNames) assert.ok(SkillCurator.methods[name]);
  assert.equal(inputSchema.safeParse({ arbitrary_shell: 'rm' }).success, false);
  assert.equal(settingsSchema.safeParse(defaults).success, true);
});
test('settings use optimistic locking and cannot disable secret or manual protection', async (t) => {
  const { call } = fixture(t);
  const result = (await call('settings.patch', {
    expected_revision: 0,
    patch: { execution: { default_mode: 'session' } },
  })) as { revision: number };
  assert.equal(result.revision, 1);
  await assert.rejects(
    call('settings.patch', { expected_revision: 0, patch: { enabled: false } }),
    code('revision_conflict'),
  );
  for (const patch of [
    { privacy: { redact_secrets: false } },
    { approval: { protect_manual_skills: false } },
    { limits: { daily_cost_usd: -1 } },
    { execution: { max_parallel_total: 0 } },
  ])
    await assert.rejects(
      call('settings.patch', { expected_revision: 1, patch }),
      code('validation_error'),
    );
});
test('secret, PII and private path redaction covers representative formats', () => {
  const sample =
    'api_key=top-secret Bearer abcdefghijklmnopqrst user@company.example /home/person/private/file sk-proj-abcdefghijklmnopqrst';
  const output = redact(sample);
  for (const secret of [
    'top-secret',
    'abcdefghijklmnopqrst',
    'user@company.example',
    '/home/person',
  ])
    assert.equal(output.includes(secret), false);
  assert.equal(containsSecrets('A plain portable instruction'), false);
});
test('zero or unknown usage never archives; pin/lock/manual override age', async (t) => {
  const { core, call } = fixture(t);
  const base = (await call('skills.create', { files: pack('aged') })) as Skill;
  const old = {
    ...base,
    updated_at: '2020-01-01T00:00:00.000Z',
    last_used_at: '2020-01-01T00:00:00.000Z',
    use_count: 3,
  };
  const settings = core.settings.get(scope).settings;
  for (const skill of [
    { ...old, use_count: 0 },
    { ...old, pinned: true },
    { ...old, locked: true },
    { ...old, management_policy: 'manual' as const },
  ])
    assert.equal(deterministicReview([skill], settings).length, 0);
  assert.equal(deterministicReview([old], settings)[0]!.type, 'archive');
});
test('pagination does not leak data and rejects malformed cursors', async (t) => {
  const { call } = fixture(t);
  await call('skills.create', { files: pack('a') });
  await call('skills.create', { files: pack('b') });
  const first = (await call('skills.list', { limit: 1 })) as { items: Skill[]; cursor: string };
  const second = (await call('skills.list', { limit: 1, cursor: first.cursor })) as {
    items: Skill[];
  };
  assert.notEqual(first.items[0]!.skill_id, second.items[0]!.skill_id);
  await assert.rejects(call('skills.list', { cursor: '../../file' }), code('validation_error'));
});
