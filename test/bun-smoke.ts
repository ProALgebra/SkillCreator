import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuratorCore } from '../src/core.ts';
import type { Skill, Principal } from '../src/types.ts';
const dir = mkdtempSync(join(tmpdir(), 'curator-bun-'));
const owner: Principal = {
  subject: 'bun-owner',
  tenant_id: 'bun-tenant',
  workspace_ids: ['bun-workspace'],
  roles: ['administrator'],
};
const scope = { tenant_id: owner.tenant_id, workspace_id: owner.workspace_ids[0]! };
let core = new CuratorCore({
  dataDirectory: dir,
  executors: { direct: async () => ({ output: { updates: [] }, cost_usd: 0.1 }) },
});
try {
  assert.equal(core.store.db.driver, 'bun:sqlite');
  const files = {
    'SKILL.md':
      '---\nname: bun-skill\ndescription: Validate Bun runtime integration.\n---\n\nUse the checked procedure.\n',
  };
  const skill = (await core.call(
    'skills.create',
    { files, idempotency_key: 'bun-create' },
    owner,
  )) as Skill;
  assert.equal(core.catalog.packages.diskHash(skill), skill.package_hash);
  await core.call(
    'curator.review',
    { execution: { mode: 'direct' }, idempotency_key: 'bun-review' },
    owner,
  );
  await core.tick();
  assert.equal(core.jobs.list(scope)[0]!.status, 'completed');
  await core.call(
    'skills.archive',
    { skill_id: skill.skill_id, expected_revision: 1, idempotency_key: 'bun-archive' },
    owner,
  );
  await core.close();
  core = new CuratorCore({ dataDirectory: dir });
  assert.equal(core.catalog.get(scope, skill.skill_id).state, 'archived');
  await core.call(
    'skills.restore',
    { skill_id: skill.skill_id, expected_revision: 2, idempotency_key: 'bun-restore' },
    owner,
  );
  assert.equal(core.catalog.get(scope, skill.skill_id).state, 'active');
  await core.store.db.backup(join(dir, 'backup.sqlite'));
  console.log('Bun native SQLite: create/review/archive/restart/restore/backup passed');
} finally {
  await core.close();
  rmSync(dir, { recursive: true, force: true });
}
