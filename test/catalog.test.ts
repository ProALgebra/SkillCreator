import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, pack, scope, owner, code } from './helpers.js';
import type { Skill, Proposal } from '../src/types.js';
import { validatePackage } from '../src/packages.js';

test('create/update/archive/restore/rollback preserve full version history', async (t) => {
  const { core, call } = fixture(t);
  const first = (await call('skills.create', { files: pack('first') })) as Skill;
  assert.equal(first.revision, 1);
  assert.equal(core.catalog.packages.diskHash(first), first.package_hash);
  const second = (await call('skills.update', {
    skill_id: first.skill_id,
    expected_revision: 1,
    files: pack('first', 'New instructions'),
  })) as Skill;
  assert.equal(second.revision, 2);
  await assert.rejects(
    call('skills.update', { skill_id: first.skill_id, expected_revision: 1, files: pack('first') }),
    code('revision_conflict'),
  );
  const archived = (await call('skills.archive', {
    skill_id: first.skill_id,
    expected_revision: 2,
  })) as Skill;
  assert.equal(archived.state, 'archived');
  assert.equal(existsSync(core.catalog.packages.path(scope, first.skill_id)), false);
  await call('skills.restore', { skill_id: first.skill_id, expected_revision: 3 });
  const rolled = (await call('skills.rollback', {
    skill_id: first.skill_id,
    expected_revision: 4,
    target_revision: 1,
  })) as Skill;
  assert.equal(rolled.files['SKILL.md'], first.files['SKILL.md']);
  assert.equal(core.catalog.history(scope, first.skill_id).length, 5);
});
test('identical requests replay exact result; payload conflicts fail', async (t) => {
  const { call, core } = fixture(t);
  const request = { files: pack('unique'), idempotency_key: 'create-once' };
  const a = await call('skills.create', request);
  const b = await call('skills.create', request);
  assert.deepEqual(a, b);
  assert.equal(core.catalog.list(scope).length, 1);
  await assert.rejects(
    call('skills.create', { ...request, files: pack('other') }),
    code('idempotency_conflict'),
  );
});
test('dry_run writes no skills, proposals, audit or idempotency records', async (t) => {
  const { core, call } = fixture(t);
  const before = core.store.all('events').length;
  await call('skills.create', { files: pack('dry'), dry_run: true });
  assert.equal(core.catalog.list(scope).length, 0);
  assert.equal(core.store.all('idempotency').length, 0);
  assert.equal(core.store.all('events').length, before);
});
test('parallel writers using same revision cannot overwrite each other', async (t) => {
  const { call } = fixture(t);
  const skill = (await call('skills.create', { files: pack('shared') })) as Skill;
  const results = await Promise.allSettled(
    ['A', 'B'].map((body) =>
      call('skills.update', {
        skill_id: skill.skill_id,
        expected_revision: 1,
        files: pack('shared', body),
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
});
test('locked, manual and readonly policies block every automatic proposal path', async (t) => {
  const { core, call } = fixture(t);
  let skill = (await call('skills.create', { files: pack('protected') })) as Skill;
  skill = (await call('skills.unadopt', {
    skill_id: skill.skill_id,
    expected_revision: skill.revision,
  })) as Skill;
  assert.throws(
    () =>
      core.catalog.proposal(
        scope,
        owner.subject,
        'patch',
        [
          {
            action: 'update',
            skill_id: skill.skill_id,
            expected_revision: skill.revision,
            files: pack('protected', 'Updated'),
          },
        ],
        'Automatic',
        [],
        true,
      ),
    code('readonly_skill'),
  );
  skill = (await call('skills.adopt', {
    skill_id: skill.skill_id,
    expected_revision: skill.revision,
  })) as Skill;
  skill = (await call('skills.lock', {
    skill_id: skill.skill_id,
    expected_revision: skill.revision,
  })) as Skill;
  await assert.rejects(
    call('skills.update', {
      skill_id: skill.skill_id,
      expected_revision: skill.revision,
      files: pack('protected'),
    }),
    code('locked_skill'),
  );
  await assert.rejects(
    call('skills.unlock', { skill_id: skill.skill_id, expected_revision: skill.revision }),
    code('validation_error'),
  );
  skill = (await call('skills.unlock', {
    skill_id: skill.skill_id,
    expected_revision: skill.revision,
    reason: 'Owner approved maintenance',
  })) as Skill;
  assert.equal(skill.locked, false);
});
test('proposal integrity and revision revalidation protect approved changes', async (t) => {
  const { core, call } = fixture(t);
  const skill = (await call('skills.create', { files: pack('review') })) as Skill;
  const proposal = core.catalog.proposal(
    scope,
    owner.subject,
    'patch',
    [
      {
        action: 'update',
        skill_id: skill.skill_id,
        expected_revision: 1,
        files: pack('review', 'Proposed'),
      },
    ],
    'A correction',
  );
  await call('proposals.approve', { proposal_id: proposal.proposal_id, expected_revision: 1 });
  await call('skills.update', {
    skill_id: skill.skill_id,
    expected_revision: 1,
    files: pack('review', 'Manual correction'),
  });
  await assert.rejects(
    call('proposals.apply', { proposal_id: proposal.proposal_id, expected_revision: 2 }),
    code('revision_conflict'),
  );
  const damaged = core.catalog.getProposal(scope, proposal.proposal_id);
  damaged.changes[0]!.files = pack('review', 'Tampered');
  core.store.put('proposals', damaged.proposal_id, damaged);
  assert.throws(() => core.catalog.validateProposal(damaged), code('validation_error'));
});
test('merge keeps binary assets, scripts, relative links and original versions', async (t) => {
  const { call, core } = fixture(t);
  const files = {
    ...pack('one', '[Guide](references/guide.md)'),
    'references/guide.md': '[Asset](../assets/icon.bin)',
    'assets/icon.bin': 'base64:AP8B/g==',
    'scripts/run.sh': '#!/bin/sh\nexit 0\n',
  };
  const a = (await call('skills.create', { files })) as Skill;
  const b = (await call('skills.create', { files: pack('two') })) as Skill;
  const p = (await call('skills.merge.preview', {
    skill_ids: [a.skill_id, b.skill_id],
    name: 'merged',
  })) as Proposal;
  await assert.rejects(
    call('proposals.apply', { proposal_id: p.proposal_id, expected_revision: 1 }),
    code('forbidden'),
  );
  await call('proposals.approve', { proposal_id: p.proposal_id, expected_revision: 1 });
  const result = (await call('proposals.apply', {
    proposal_id: p.proposal_id,
    expected_revision: 2,
  })) as { skills: Skill[] };
  const merged = result.skills.find((s) => s.name === 'merged')!;
  for (const [path, value] of Object.entries(files))
    assert.equal(merged.files['sources/' + a.skill_id + '/' + path], value);
  assert.equal(core.catalog.get(scope, a.skill_id).state, 'superseded');
  assert.equal(core.catalog.get(scope, a.skill_id).replaced_by, merged.skill_id);
  assert.deepEqual(
    [
      ...readFileSync(
        join(
          core.catalog.packages.path(scope, merged.skill_id),
          'sources',
          a.skill_id,
          'assets/icon.bin',
        ),
      ),
    ],
    [0, 255, 1, 254],
  );
  assert.equal(
    core.catalog.history(scope, a.skill_id)[0]!.skill.files['scripts/run.sh'],
    files['scripts/run.sh'],
  );
});
test('split rejects lost dependencies before saving a proposal', async (t) => {
  const { call, core } = fixture(t);
  const source = (await call('skills.create', {
    files: { ...pack('wide'), 'scripts/required.sh': 'echo safe' },
  })) as Skill;
  await assert.rejects(
    call('skills.split.preview', {
      skill_id: source.skill_id,
      parts: [pack('part-a'), pack('part-b')],
    }),
    code('validation_error'),
  );
  assert.equal(core.store.all('proposals').length, 0);
});
test('disk edits produce revision conflict; refresh imports the external edit', async (t) => {
  const { call, core } = fixture(t);
  const skill = (await call('skills.create', { files: pack('disk') })) as Skill;
  writeFileSync(
    join(core.catalog.packages.path(scope, skill.skill_id), 'SKILL.md'),
    pack('disk', 'Edited outside')['SKILL.md']!,
  );
  await assert.rejects(
    call('skills.update', {
      skill_id: skill.skill_id,
      expected_revision: 1,
      files: pack('disk', 'Overwrite'),
    }),
    code('revision_conflict'),
  );
  await call('manager.refresh');
  assert.equal(core.catalog.get(scope, skill.skill_id).revision, 2);
});
test('package validation blocks traversal, missing dependencies and secrets', async (t) => {
  const { call } = fixture(t);
  for (const files of [
    { ...pack('bad'), '../escape': 'bad' },
    { ...pack('bad'), 'a/b': 'x', a: 'x' },
    pack('bad', '[Missing](not-present.md)'),
    pack('bad', 'api_key=unpublished-sensitive-value'),
  ])
    await assert.rejects(call('skills.create', { files }), code('validation_error'));
  assert.throws(() => validatePackage({ 'SKILL.md': 'no front matter' }), code('validation_error'));
});
test('symlinks and hardlinks in active packages prevent writes', async (t) => {
  const { call, core, dir } = fixture(t);
  const a = (await call('skills.create', { files: pack('links') })) as Skill;
  const path = core.catalog.packages.path(scope, a.skill_id);
  writeFileSync(join(dir, 'outside'), 'private');
  symlinkSync(join(dir, 'outside'), join(path, 'leak'));
  await assert.rejects(
    call('skills.archive', { skill_id: a.skill_id, expected_revision: 1 }),
    code('validation_error'),
  );
  const b = (await call('skills.create', { files: pack('hardlinks') })) as Skill;
  linkSync(join(dir, 'outside'), join(core.catalog.packages.path(scope, b.skill_id), 'leak'));
  await assert.rejects(
    call('skills.update', { skill_id: b.skill_id, expected_revision: 1, files: pack('hardlinks') }),
    code('validation_error'),
  );
});
