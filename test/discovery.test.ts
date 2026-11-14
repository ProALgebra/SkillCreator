import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, scope, pack, code } from './helpers.js';
import { containsSecrets, redact } from '../src/learning.js';

test('discovery keeps virtual SDK skills with display names and body-only content visible and readonly', async (t) => {
  const { core, call } = fixture(t);
  const entries = ['OpenCode', 'Report', 'Browser'].map((name) => ({
    name,
    description: `Built-in ${name} instructions`,
    path: `skill://${name.toLowerCase()}/SKILL.md`,
    content: `# ${name}\n\nFollow the built-in ${name} procedure.`,
  }));

  core.catalog.discover(scope, 'opencode', entries, []);
  const skills = core.catalog.list(scope);
  assert.equal(skills.length, entries.length);
  for (const entry of entries) {
    const skill = skills.find((s) => s.source_path === entry.path)!;
    assert.equal(skill.name, entry.name);
    assert.equal(skill.description, entry.description);
    assert.equal(skill.files['SKILL.md'], entry.content);
    assert.equal(skill.validation_status, 'incomplete_source');
    assert.equal(skill.management_policy, 'readonly');
    assert.equal(skill.scope, 'external');
    for (const method of ['skills.update', 'skills.adopt'] as const)
      await assert.rejects(
        call(method, {
          skill_id: skill.skill_id,
          expected_revision: skill.revision,
          ...(method === 'skills.update' ? { files: pack('replacement') } : {}),
        }),
        code('readonly_skill'),
      );
    await assert.rejects(
      call('skills.clone', { skill_id: skill.skill_id, name: 'cloned-source' }),
      code('validation_error'),
    );
  }
  const plan = core.optimizer.prepare(
    scope,
    skills.map((s) => s.skill_id),
  );
  assert.deepEqual(plan.batches, []);
  assert.equal(plan.skipped.length, skills.length);

  const revisions = skills.map((s) => [s.skill_id, s.revision]);
  const historyCount = core.store.all('skill_versions').length;
  core.catalog.discover(scope, 'opencode', entries, []);
  assert.deepEqual(
    core.catalog.list(scope).map((s) => [s.skill_id, s.revision]),
    revisions,
  );
  assert.equal(core.store.all('skill_versions').length, historyCount);

  core.catalog.discover(
    scope,
    'opencode',
    [{ ...entries[0]!, description: 'Updated instructions' }],
    [],
  );
  const changed = core.catalog.get(scope, skills[0]!.skill_id);
  assert.equal(changed.description, 'Updated instructions');
  assert.equal(changed.revision, skills[0]!.revision + 1);
  assert.equal(changed.package_hash, skills[0]!.package_hash);

  assert.throws(
    () => core.catalog.create(scope, 'opencode', pack('OpenCode')),
    code('validation_error'),
  );
});

test('discovery redacts sensitive SDK examples and display metadata before persisting snapshots', async (t) => {
  const { core, call } = fixture(t);
  const entry = {
    name: 'Report sk-abcdefghijklmnopqrstuv',
    description: 'Contact maintainer@example.org for reports',
    path: 'skill://report/SKILL.md',
    content: '# Report\n\nExample: api_key: example-secret-value\nBearer abcdefghijklmnop',
  };
  assert.equal(containsSecrets(entry.name + entry.description + entry.content), true);
  core.catalog.discover(scope, 'opencode', [entry], []);
  const skill = core.catalog.list(scope)[0]!;
  assert.equal(skill.name, redact(entry.name));
  assert.equal(skill.description, redact(entry.description));
  assert.equal(skill.files['SKILL.md'], redact(entry.content));
  assert.equal(skill.source_path, entry.path);
  assert.equal(skill.validation_status, 'incomplete_source');
  assert.equal(containsSecrets(skill.name + skill.description + skill.files['SKILL.md']), false);
  for (const table of ['skills', 'skill_versions'] as const) {
    const persisted = JSON.stringify(core.store.all(table));
    for (const sensitive of [
      'sk-abcdefghijklmnopqrstuv',
      'maintainer@example.org',
      'example-secret-value',
      'abcdefghijklmnop',
    ])
      assert.equal(persisted.includes(sensitive), false);
  }
  await assert.rejects(
    call('skills.clone', { skill_id: skill.skill_id, name: 'copy-report' }),
    code('validation_error'),
  );
  core.catalog.discover(scope, 'opencode', [entry], []);
  assert.equal(core.catalog.list(scope).length, 1);
  assert.equal(core.catalog.get(scope, skill.skill_id).revision, 1);
});

test('discovery does not mark a readable but unsafe source package valid or retain its auxiliary files', async (t) => {
  const { core, dir, call } = fixture(t);
  const root = join(dir, 'unsafe-source');
  mkdirSync(root, { recursive: true });
  const source = pack('unsafe-source');
  const unsafe = 'api_key: example-credential';
  writeFileSync(join(root, 'SKILL.md'), source['SKILL.md']!);
  writeFileSync(join(root, 'credentials.txt'), unsafe);
  core.catalog.discover(
    scope,
    'opencode',
    [
      {
        name: 'Unsafe Source',
        description: 'SDK-only preview of a rejected package',
        path: join(root, 'SKILL.md'),
        content: source['SKILL.md'],
      },
    ],
    [root],
  );

  const skill = core.catalog.list(scope)[0]!;
  assert.equal(skill.name, 'Unsafe Source');
  assert.equal(skill.validation_status, 'incomplete_source');
  assert.equal(skill.management_policy, 'readonly');
  assert.deepEqual(skill.files, { 'SKILL.md': source['SKILL.md'] });
  assert.equal(JSON.stringify(core.store.all('skills')).includes('example-credential'), false);
  assert.equal(readFileSync(join(root, 'credentials.txt'), 'utf8'), unsafe);
  await assert.rejects(
    call('skills.clone', { skill_id: skill.skill_id, name: 'unsafe-clone' }),
    code('validation_error'),
  );
});

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
  assert.deepEqual(skill.files, { ...pack('external'), 'extra.txt': 'preserve me' });
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
