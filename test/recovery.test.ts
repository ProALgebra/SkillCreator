import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CuratorCore } from '../src/core.js';
import { fixture, pack, scope, owner } from './helpers.js';
import type { Skill } from '../src/types.js';
import type { Job } from '../src/jobs.js';
const cwd = fileURLToPath(new URL('../', import.meta.url));

test('restart preserves catalog, settings, proposals, audit, history and queued jobs', async (t) => {
  const { core, call, dir } = fixture(t, {
    executors: { direct: async () => ({ output: { updates: [] }, cost_usd: 0 }) },
  });
  const skill = (await call('skills.create', { files: pack('persistent') })) as Skill;
  await call('settings.patch', {
    expected_revision: 0,
    patch: { curator: { stale_after_days: 40 } },
  });
  const p = core.catalog.proposal(
    scope,
    'alice',
    'patch',
    [
      {
        action: 'update',
        skill_id: skill.skill_id,
        expected_revision: 1,
        files: pack('persistent', 'New'),
      },
    ],
    'Correction',
  );
  const j = (await call('curator.review', { execution: { mode: 'direct' } })) as Job;
  await core.close();
  const reopened = new CuratorCore({
    dataDirectory: dir,
    executors: { direct: async () => ({ output: { updates: [] }, cost_usd: 0 }) },
  });
  t.after(() => reopened.close());
  assert.equal(reopened.catalog.get(scope, skill.skill_id).name, 'persistent');
  assert.equal(reopened.catalog.history(scope, skill.skill_id).length, 1);
  assert.equal(reopened.catalog.getProposal(scope, p.proposal_id).status, 'pending');
  assert.equal(reopened.settings.get(scope).revision, 1);
  assert.equal(reopened.settings.get(scope).settings.curator.stale_after_days, 40);
  assert.equal(reopened.jobs.get(scope, j.job_id).status, 'queued');
  assert.ok(reopened.store.all('audit_log').length);
  await reopened.tick();
  assert.equal(reopened.jobs.get(scope, j.job_id).status, 'completed');
});
for (const committed of [false, true])
  test(`abrupt process exit recovers ${committed ? 'committed' : 'uncommitted'} multi-file publication`, async (t) => {
    const { core, call, dir } = fixture(t);
    const old = (await call('skills.create', {
      files: { ...pack('recover'), 'assets/a.txt': 'old' },
    })) as Skill;
    await core.close();
    const script = `import { CuratorCore } from './src/core.ts';import { hash } from './src/security.ts';const c=new CuratorCore({dataDirectory:${JSON.stringify(dir)}});const old=c.catalog.get(${JSON.stringify(scope)},${JSON.stringify(old.skill_id)});const files={...old.files,'assets/a.txt':'new','assets/b.txt':'new dependency'};const next={...old,files,revision:2,package_hash:hash(files)};c.store.put('publications','crashed',{id:'crashed',before:[old],after:[next],committed:${committed}});c.catalog.packages.write(next);${committed ? "c.store.put('skills',next.skill_id,next);" : ''}process.exit(23);`;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(child.status, 23, child.stderr);
    const restored = new CuratorCore({ dataDirectory: dir });
    t.after(() => restored.close());
    const current = restored.catalog.get(scope, old.skill_id);
    assert.equal(current.files['assets/a.txt'], committed ? 'new' : 'old');
    assert.equal(restored.catalog.packages.diskHash(current), current.package_hash);
    assert.equal(
      existsSync(restored.catalog.packages.path(scope, current.skill_id) + '/assets/b.txt'),
      committed,
    );
    assert.equal(restored.store.all('publications').length, 0);
  });
test('durable external lease survives restart without scheduling another run', async (t) => {
  const { core, call, dir } = fixture(t);
  await call('settings.patch', {
    expected_revision: 0,
    patch: { valeria_bridge: { enabled: true } },
  });
  const j = (await call('curator.review', { execution: { mode: 'valeria' } })) as Job;
  const worker = {
    ...owner,
    subject: 'worker-a',
    roles: ['worker'] as ['worker'],
    worker_kind: 'valeria' as const,
  };
  const lease = (await call(
    'jobs.lease',
    { worker_id: worker.subject, worker_kind: 'valeria' },
    worker,
  )) as { lease_token: string };
  await core.close();
  const reopened = new CuratorCore({ dataDirectory: dir });
  t.after(() => reopened.close());
  assert.equal(reopened.jobs.get(scope, j.job_id).status, 'running');
  assert.equal(reopened.jobs.lease(scope, 'valeria', 'worker-b'), null);
  await reopened.jobs.complete(scope, j.job_id, worker.subject, lease.lease_token, {
    output: { updates: [] },
    cost_usd: 0.1,
  });
  assert.equal(reopened.jobs.get(scope, j.job_id).status, 'completed');
});
test('storage rejects a second writer process instance', async (t) => {
  const { dir } = fixture(t);
  assert.throws(() => new CuratorCore({ dataDirectory: dir }), /already open/);
});
test('SQLite transaction rolls back events and does not notify subscribers', (t) => {
  const { core } = fixture(t);
  let notified = 0;
  core.store.subscribe(() => notified++);
  assert.throws(() =>
    core.store.transaction(() => {
      core.store.emit('skill.updated', scope, 'alice', 'x');
      throw new Error('rollback');
    }),
  );
  assert.equal(core.store.all('events').length, 0);
  assert.equal(notified, 0);
});
