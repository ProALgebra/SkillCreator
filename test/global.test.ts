import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner, pack, scope, code } from './helpers.js';
import type { Principal, Skill } from '../src/types.js';
test('global publication is explicit admin action and visible only within its tenant', async (t) => {
  const { call } = fixture(t);
  const skill = (await call('skills.create', {
    files: pack('tenant-global'),
    skill_scope: 'global',
  })) as Skill;
  assert.equal(skill.scope, 'global');
  const other: Principal = { ...owner, workspace_ids: ['workspace-b'], roles: ['viewer'] };
  const visible = (await call('skills.get', { skill_id: skill.skill_id }, other)) as Skill;
  assert.equal(visible.skill_id, skill.skill_id);
  await assert.rejects(
    call('skills.get', { skill_id: skill.skill_id }, { ...other, tenant_id: 'other-tenant' }),
    code('not_found'),
  );
  await assert.rejects(
    call(
      'skills.create',
      { files: pack('editor-global'), skill_scope: 'global' },
      { ...owner, roles: ['editor'] },
    ),
    code('forbidden'),
  );
  await assert.rejects(
    call(
      'skills.update',
      { skill_id: skill.skill_id, expected_revision: 1, files: pack('tenant-global', 'change') },
      { ...owner, workspace_ids: ['workspace-b'] },
    ),
    code('scope_violation'),
  );
});
