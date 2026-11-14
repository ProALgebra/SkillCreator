import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { code, fixture, pack, scope } from './helpers.js';
import type { Skill } from '../src/types.js';

const quote = 'Preserve the durable marker before retrying a failed request.';

function setup(t: TestContext) {
  const { core } = fixture(t, {
    executors: { direct: async () => ({ output: { actions: [] }, cost_usd: 0 }) },
  });
  const catalog = core.catalog;
  const create = (name: string) => catalog.create(scope, 'alice', pack(name, quote.repeat(8)));
  const state = (skill: Skill, next: Skill['state']) =>
    catalog.update(scope, 'alice', skill.skill_id, skill.revision, { state: next });
  const plan = (skills: Skill[], name: string) => {
    const job = core.jobs.run(
      scope,
      'alice',
      'optimize',
      core.optimizer.prepare(
        scope,
        skills.map((s) => s.skill_id),
      ).batches[0]!,
      { mode: 'direct' },
      randomUUID(),
    );
    return core.optimizer.acceptResult(job, {
      actions: [
        {
          action: 'merge',
          skill_ids: skills.map((s) => s.skill_id),
          rationale: 'Combine duplicated retry instructions.',
          name,
          files: pack(name, quote),
          coverage: skills.map((s) => ({ skill_id: s.skill_id, quotes: [quote] })),
        },
      ],
    })[0]!;
  };
  const apply = (id: string) => {
    const p = catalog.getProposal(scope, id);
    const approved = catalog.decide(scope, 'alice', id, 'approved', p.revision);
    return catalog.apply(scope, 'alice', id, approved.revision);
  };
  return { core, catalog, create, state, plan, apply };
}

test('semantic merges cannot shadow an unrelated stale skill still published by OpenCode', (t) => {
  const f = setup(t);
  const a = f.create('source-alpha');
  const b = f.create('source-beta');
  f.state(f.create('published-retries'), 'stale');
  assert.throws(() => f.plan([a, b], 'published-retries'), code('revision_conflict'));
  assert.equal(f.core.store.all('proposals').length, 0);
  assert.equal(f.catalog.get(scope, a.skill_id).state, 'active');
});

test('create, rename, restore and historical rollback guard both active and stale names', (t) => {
  const f = setup(t);
  const original = f.create('shared-name');
  const archived = f.state(original, 'archived');
  const published = f.state(f.create('shared-name'), 'stale');
  assert.throws(() => f.create('shared-name'), code('validation_error'));
  assert.throws(() => f.state(archived, 'active'), code('validation_error'));
  const other = f.create('another-name');
  assert.throws(
    () => f.catalog.rename(scope, 'alice', other.skill_id, other.revision, published.name),
    code('validation_error'),
  );
  const renamed = f.catalog.rename(scope, 'alice', other.skill_id, other.revision, 'renamed');
  f.state(f.create('another-name'), 'stale');
  assert.throws(
    () => f.catalog.rollback(scope, 'alice', renamed.skill_id, renamed.revision, 1),
    code('validation_error'),
  );
});

test('archived and superseded names can be reused while hidden renames do not create collisions', (t) => {
  const f = setup(t);
  const archived = f.state(f.create('reusable-name'), 'archived');
  const replacement = f.create('reusable-name');
  assert.equal(replacement.state, 'active');
  f.state(replacement, 'superseded');
  assert.equal(f.create('reusable-name').state, 'active');
  const hidden = f.state(f.create('hidden-name'), 'archived');
  const renamed = f.catalog.rename(scope, 'alice', hidden.skill_id, hidden.revision, archived.name);
  assert.equal(renamed.state, 'archived');
  assert.throws(() => f.state(renamed, 'stale'), code('validation_error'));
});

test('optimization inverse application refuses names occupied by later stale skills atomically', (t) => {
  const f = setup(t);
  const a = f.create('inverse-alpha');
  const b = f.create('inverse-beta');
  const applied = f.apply(f.plan([a, b], 'combined-inverse'));
  const replacement = f.state(f.create(a.name), 'stale');
  const inverse = f.core.optimizer.rollback(
    scope,
    'alice',
    applied.proposal.proposal_id,
    applied.proposal.revision,
  );
  const approved = f.catalog.decide(
    scope,
    'alice',
    inverse.proposal_id,
    'approved',
    inverse.revision,
  );
  assert.throws(
    () => f.catalog.apply(scope, 'alice', approved.proposal_id, approved.revision),
    code('validation_error'),
  );
  assert.equal(f.catalog.get(scope, a.skill_id).state, 'superseded');
  assert.equal(f.catalog.get(scope, b.skill_id).state, 'superseded');
  assert.equal(f.catalog.get(scope, replacement.skill_id).state, 'stale');
  assert.equal(applied.skills.filter((s) => s.state === 'active').length, 1);
  const target = applied.skills.find((s) => s.state === 'active')!;
  assert.equal(f.catalog.get(scope, target.skill_id).state, 'active');
  f.catalog.verifyDisk(f.catalog.get(scope, target.skill_id));
});
