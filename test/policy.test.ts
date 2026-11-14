import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, pack, scope, code } from './helpers.js';
import type { Skill, Proposal } from '../src/types.js';

test('explicit auto policy applies only managed low-risk patches with audited approval', async (t) => {
  let target: Skill;
  const { call, core } = fixture(t, {
    executors: {
      direct: async () => ({
        output: {
          updates: [
            {
              skill_id: target.skill_id,
              files: pack('auto', 'Validated improvement'),
              rationale: 'Clarify the validated procedure',
            },
          ],
        },
        cost_usd: 0.1,
      }),
    },
  });
  target = (await call('skills.create', { files: pack('auto') })) as Skill;
  await call('settings.patch', {
    expected_revision: 0,
    patch: { approval: { mode: 'auto', allow_auto_patch_managed_low_risk: true } },
  });
  await call('curator.review', { execution: { mode: 'direct' } });
  await core.tick();
  assert.equal(core.catalog.get(scope, target.skill_id).revision, 2);
  assert.equal(core.store.all<Proposal>('proposals')[0]!.status, 'applied');
  assert.ok(
    core.store
      .all<{ actor: string; type: string }>('audit_log')
      .some((e) => e.actor === 'system.policy' && e.type === 'proposal.approved'),
  );
});
test('safe mode keeps automatic patches pending even if an auto flag is set', async (t) => {
  let target: Skill;
  const { call, core } = fixture(t, {
    executors: {
      direct: async () => ({
        output: {
          updates: [
            {
              skill_id: target.skill_id,
              files: pack('safe', 'Improvement'),
              rationale: 'Clarify instructions',
            },
          ],
        },
        cost_usd: 0.1,
      }),
    },
  });
  target = (await call('skills.create', { files: pack('safe') })) as Skill;
  await call('settings.patch', {
    expected_revision: 0,
    patch: { approval: { mode: 'safe', allow_auto_patch_managed_low_risk: true } },
  });
  await call('curator.review', { execution: { mode: 'direct' } });
  await core.tick();
  assert.equal(core.catalog.get(scope, target.skill_id).revision, 1);
  assert.equal(core.store.all<Proposal>('proposals')[0]!.status, 'pending');
});
test('system pause prevents queued jobs from dispatching until resume', async (t) => {
  let count = 0;
  const { call, core } = fixture(t, {
    executors: {
      direct: async () => {
        count++;
        return { output: { updates: [] }, cost_usd: 0 };
      },
    },
  });
  await call('curator.review', { execution: { mode: 'direct' } });
  await call('system.pause');
  await core.tick();
  assert.equal(count, 0);
  await assert.rejects(
    call('curator.review', { execution: { mode: 'direct' } }),
    code('executor_unavailable'),
  );
  await call('system.resume');
  await core.tick();
  assert.equal(count, 1);
});
test('lifecycle suggestions deduplicate, archive under explicit policy, and retain versions', async (t) => {
  const { call, core } = fixture(t);
  const s = (await call('skills.create', { files: pack('aged-policy') })) as Skill;
  core.store.put('skills', s.skill_id, {
    ...s,
    updated_at: '2020-01-01T00:00:00.000Z',
    last_used_at: '2020-01-01T00:00:00.000Z',
    use_count: 2,
  });
  await call('curator.lifecycle_run');
  await call('curator.lifecycle_run');
  assert.equal(core.store.all('proposals').length, 1);
  await call('settings.patch', {
    expected_revision: 0,
    patch: { approval: { mode: 'auto', allow_auto_archive_managed: true } },
  });
  await call('curator.lifecycle_run');
  assert.equal(core.catalog.get(scope, s.skill_id).state, 'archived');
  assert.equal(core.catalog.history(scope, s.skill_id).length, 2);
});
