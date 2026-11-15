import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuratorCore } from '../src/core.js';
import type { Skill } from '../src/types.js';
import { fixture, pack, scope, owner, code } from './helpers.js';

function assertFiles(core: CuratorCore, skill: Skill): void {
  assert.equal(core.catalog.packages.diskHash(skill), skill.package_hash);
  assert.deepEqual(
    core.catalog.packages.read(core.catalog.packages.path(skill, skill.skill_id)),
    skill.files,
  );
}

test('committed publication cleanup failure blocks later publication until reconciliation', async (t) => {
  const { core, dir } = fixture(t);
  const original = core.catalog.create(scope, owner.subject, pack('cleanup'));
  const remove = core.store.delete.bind(core.store);
  let cleanupBroken = true;
  t.mock.method(core.store, 'delete', (table, id) => {
    if (table === 'publications' && cleanupBroken) throw new Error('journal cleanup failed');
    remove(table, id);
  });

  const updated = core.catalog.update(scope, owner.subject, original.skill_id, 1, {
    files: pack('cleanup', 'The committed replacement.'),
  });
  assert.equal(updated.revision, 2);
  assertFiles(core, updated);
  assert.equal(core.catalog.recoveryPending, true);
  assert.equal(core.catalog.history(scope, original.skill_id).length, 2);
  assert.throws(
    () =>
      core.catalog.update(scope, owner.subject, updated.skill_id, 2, {
        files: pack('cleanup', 'A later publication.'),
      }),
    /journal cleanup failed/,
  );
  assert.equal(core.catalog.get(scope, original.skill_id).revision, 2);
  assertFiles(core, updated);
  assert.equal(core.store.all('publications').length, 1);

  cleanupBroken = false;
  const later = core.catalog.update(scope, owner.subject, updated.skill_id, 2, {
    files: pack('cleanup', 'A later publication.'),
  });
  assert.equal(later.revision, 3);
  assert.equal(core.catalog.recoveryPending, false);
  await core.close();
  const restored = new CuratorCore({ dataDirectory: dir });
  try {
    const current = restored.catalog.get(scope, original.skill_id);
    assert.equal(current.revision, 3);
    assertFiles(restored, current);
    assert.equal(restored.store.all('publications').length, 0);
  } finally {
    await restored.close();
  }
});

test('a transaction error after COMMIT uses the durable publication phase', (t) => {
  const { core } = fixture(t);
  const original = core.catalog.create(scope, owner.subject, pack('committed'));
  const transact = core.store.transaction.bind(core.store);
  t.mock.method(core.store, 'transaction', (fn) => {
    transact(fn);
    throw new Error('transaction wrapper failed after commit');
  });
  const updated = core.catalog.update(scope, owner.subject, original.skill_id, 1, {
    files: pack('committed', 'The committed replacement.'),
  });
  assert.equal(updated.revision, 2);
  assertFiles(core, updated);
  assert.equal(core.catalog.history(scope, original.skill_id).length, 2);
  assert.equal(core.catalog.recoveryPending, false);
});

test('publication failure before COMMIT restores files, versions, and audit state', (t) => {
  const { core } = fixture(t);
  const original = core.catalog.create(scope, owner.subject, pack('rolled-back'));
  const events = core.store.all('events').length;
  const put = core.store.put.bind(core.store);
  t.mock.method(core.store, 'put', (table, id, value) => {
    if (table === 'skills') throw new Error('catalog write failed');
    put(table, id, value);
  });
  assert.throws(
    () =>
      core.catalog.update(scope, owner.subject, original.skill_id, 1, {
        files: pack('rolled-back', 'An uncommitted replacement.'),
      }),
    /catalog write failed/,
  );
  assert.equal(core.catalog.get(scope, original.skill_id).revision, 1);
  assertFiles(core, original);
  assert.equal(core.catalog.history(scope, original.skill_id).length, 1);
  assert.equal(core.store.all('events').length, events);
  assert.equal(core.catalog.recoveryPending, false);
});

test('failed filesystem rollback retains its journal for recovery', (t) => {
  const { core } = fixture(t);
  const original = core.catalog.create(scope, owner.subject, pack('restore-later'));
  const put = core.store.put.bind(core.store);
  const write = core.catalog.packages.write.bind(core.catalog.packages);
  const putMock = t.mock.method(core.store, 'put', (table, id, value) => {
    if (table === 'skills') throw new Error('catalog write failed');
    put(table, id, value);
  });
  const writeMock = t.mock.method(core.catalog.packages, 'write', (skill) => {
    if (skill.revision === 1) throw new Error('rollback files unavailable');
    write(skill);
  });
  assert.throws(
    () =>
      core.catalog.update(scope, owner.subject, original.skill_id, 1, {
        files: pack('restore-later', 'An uncommitted replacement.'),
      }),
    /rollback files unavailable/,
  );
  assert.equal(core.catalog.recoveryPending, true);
  assert.equal(core.catalog.get(scope, original.skill_id).revision, 1);
  putMock.mock.restore();
  writeMock.mock.restore();
  core.catalog.recover();
  assertFiles(core, original);
  assert.equal(core.catalog.recoveryPending, false);
});

test('unreadable publication outcome retains files and journal until restart', async (t) => {
  const { core, dir } = fixture(t);
  const original = core.catalog.create(scope, owner.subject, pack('uncertain'));
  const read = core.store.get.bind(core.store);
  const transactionMock = t.mock.method(core.store, 'transaction', () => {
    throw new Error('commit outcome unavailable');
  });
  const readMock = t.mock.method(core.store, 'get', (table, id) => {
    if (table === 'publications') throw new Error('journal read unavailable');
    return read(table, id);
  });
  assert.throws(
    () =>
      core.catalog.update(scope, owner.subject, original.skill_id, 1, {
        files: pack('uncertain', 'The prepared replacement.'),
      }),
    code('unknown_outcome'),
  );
  assert.equal(core.store.all('publications').length, 1);
  assert.equal(core.catalog.recoveryPending, true);
  assert.notEqual(core.catalog.packages.diskHash(original), original.package_hash);
  transactionMock.mock.restore();
  readMock.mock.restore();
  assert.throws(
    () => core.catalog.create(scope, owner.subject, pack('blocked')),
    code('unknown_outcome'),
  );
  await core.close();
  const restored = new CuratorCore({ dataDirectory: dir });
  try {
    assertFiles(restored, original);
    assert.equal(restored.catalog.recoveryPending, false);
  } finally {
    await restored.close();
  }
});

test('publication rejects Store savepoints and native transactions before touching files', (t) => {
  const { core } = fixture(t);
  const original = core.catalog.create(scope, owner.subject, pack('top-level'));
  const publish = () =>
    core.catalog.update(scope, owner.subject, original.skill_id, 1, {
      files: pack('top-level', 'This must not be published.'),
    });
  assert.throws(() => core.store.transaction(publish), /top-level storage transaction/);
  assert.throws(() => core.store.db.transaction(publish)(), /top-level storage transaction/);
  assertFiles(core, original);
  assert.equal(core.catalog.get(scope, original.skill_id).revision, 1);
  assert.equal(core.store.all('publications').length, 0);
});

test('committed multi-skill proposal retains its applied state when cleanup fails', (t) => {
  const { core } = fixture(t);
  const originals = ['first-package', 'second-package'].map((name) =>
    core.catalog.create(scope, owner.subject, pack(name)),
  );
  const proposal = core.catalog.proposal(
    scope,
    owner.subject,
    'patch',
    originals.map((skill) => ({
      action: 'update',
      skill_id: skill.skill_id,
      expected_revision: skill.revision,
      files: pack(skill.name, 'A coordinated replacement.'),
    })),
    'Update both packages together.',
  );
  const approved = core.catalog.decide(scope, owner.subject, proposal.proposal_id, 'approved', 1);
  const remove = core.store.delete.bind(core.store);
  const removeMock = t.mock.method(core.store, 'delete', (table, id) => {
    if (table === 'publications') throw new Error('journal cleanup failed');
    remove(table, id);
  });
  const result = core.catalog.apply(scope, owner.subject, proposal.proposal_id, approved.revision);
  assert.equal(result.proposal.status, 'applied');
  assert.equal(core.catalog.getProposal(scope, proposal.proposal_id).status, 'applied');
  for (const skill of result.skills) {
    assert.equal(skill.revision, 2);
    assertFiles(core, skill);
  }
  removeMock.mock.restore();
  core.catalog.recover();
  for (const skill of result.skills) assertFiles(core, skill);
  assert.equal(core.catalog.recoveryPending, false);
});
