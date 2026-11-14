import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, scope, pack, code } from './helpers.js';
test('discovery catalogues API-only sources and upgrades to full readonly package on allowlist refresh', async (t) => {
  const { core, dir, call } = fixture(t);
  const root = join(dir, 'sources');
  const path = join(root, 'external');
  mkdirSync(path, { recursive: true });
  for (const [file, content] of Object.entries({ ...pack('external'), 'extra.txt': 'preserve me' }))
    writeFileSync(join(path, file), content);
  const entries = [
    {
      name: 'external',
      description: 'External reusable procedure',
      path: join(path, 'SKILL.md'),
      content: pack('external')['SKILL.md'],
    },
  ];
  core.catalog.discover(scope, 'opencode', entries, []);
  let skill = core.catalog.list(scope)[0]!;
  assert.equal(skill.validation_status, 'incomplete_source');
  assert.equal(skill.management_policy, 'readonly');
  await assert.rejects(
    call('skills.clone', { skill_id: skill.skill_id, name: 'copy' }),
    code('validation_error'),
  );
  const id = skill.skill_id;
  core.catalog.discover(scope, 'opencode', entries, [root]);
  skill = core.catalog.get(scope, id);
  assert.equal(skill.validation_status, 'valid');
  assert.equal(skill.files['extra.txt'], 'preserve me');
  await assert.rejects(
    call('skills.update', {
      skill_id: id,
      expected_revision: skill.revision,
      files: pack('external'),
    }),
    code('readonly_skill'),
  );
  const copy = (await call('skills.clone', { skill_id: id, name: 'adopted-copy' })) as {
    files: Record<string, string>;
  };
  assert.equal(copy.files['extra.txt'], 'preserve me');
});
