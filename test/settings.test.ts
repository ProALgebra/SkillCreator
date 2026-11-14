import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner, code } from './helpers.js';
test('settings inherit global then tenant then workspace, reset resumes inheritance', async (t) => {
  const { call } = fixture(t);
  const global = { ...owner, global_admin: true };
  await call(
    'settings.patch',
    {
      settings_level: 'global',
      expected_revision: 0,
      patch: { execution: { default_mode: 'session' } },
    },
    global,
  );
  await call('settings.patch', {
    settings_level: 'tenant',
    expected_revision: 0,
    patch: { execution: { default_mode: 'direct' } },
  });
  let value = (await call('settings.get')) as {
    revision: number;
    settings: { execution: { default_mode: string } };
  };
  assert.equal(value.revision, 0);
  assert.equal(value.settings.execution.default_mode, 'direct');
  await call('settings.patch', {
    expected_revision: 0,
    patch: { execution: { default_mode: 'external' } },
  });
  value = (await call('settings.get')) as typeof value;
  assert.equal(value.settings.execution.default_mode, 'external');
  await call('settings.reset', { expected_revision: 1 });
  value = (await call('settings.get')) as typeof value;
  assert.equal(value.settings.execution.default_mode, 'direct');
  const other = { ...owner, tenant_id: 'other', workspace_ids: ['other-ws'] };
  const settings = (await call('settings.get', {}, other)) as typeof value;
  assert.equal(settings.settings.execution.default_mode, 'session');
  await assert.rejects(
    call('settings.patch', {
      settings_level: 'global',
      expected_revision: 1,
      patch: { enabled: false },
    }),
    code('forbidden'),
  );
});

test('literal workspace names cannot collide with settings layer keys', (t) => {
  const { core } = fixture(t);
  const scope = { tenant_id: 'team', workspace_id: '*' };
  assert.notEqual(core.settings.key(scope, 'workspace'), core.settings.key(scope, 'tenant'));
  assert.notEqual(core.settings.key(scope, 'workspace'), core.settings.key(scope, 'global'));
});
