import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testRender } from '@opentui/solid';
import { CuratorCore } from '../src/core.ts';
import type { Principal } from '../src/types.ts';
import plugin from '../dist/tui.js';

delete process.env.DEBUG;
const dir = mkdtempSync(join(tmpdir(), 'curator-tui-'));
const core = new CuratorCore({ dataDirectory: dir });
const owner: Principal = {
  subject: 'tui-owner',
  tenant_id: 'tui',
  workspace_ids: ['tui-workspace'],
  roles: ['administrator'],
};
process.env.CURATOR_TUI_TEST_TOKEN = 'test-only-tui-capability-0123456789';
let page: { render: () => unknown };
const commands: string[] = [];
const actions = new Map<string, () => Promise<void>>();
const locations: string[] = [];
const directory = '/workspace/curator-tui-test';
let deny = false;
let rejectPublication = false;
let route: { type: string; name?: string; sessionID?: string } = {
  type: 'plugin',
  name: 'skills-manager',
};
const selections: Array<string | undefined> = [];
const selectionDialogs: Array<{ title: string; options: Array<{ value: string }> }> = [];
const prompts: Array<string | undefined> = [];
const alerts: Array<{ title: string; message: string }> = [];
const toasts: Array<{ message: string; variant?: string }> = [];
const requests: Array<{ method: string; input: Record<string, any> }> = [];
let history = [{ session_id: 'ses_previous', title: 'Previous completed conversation' }];
let refresh: () => void = () => {};
const context = {
  options: { token_env: 'CURATOR_TUI_TEST_TOKEN' },
  location: undefined as { directory: string } | undefined,
  data: { location: { default: () => ({ directory }) } },
  client: {
    rpc: () =>
      new Proxy(
        {},
        {
          get: (_, method) => async (input, options) => {
            assert.equal(options.location.directory, directory);
            locations.push(options.location.directory);
            if (deny) throw { message: 'Invalid capability token' };
            requests.push({ method: String(method), input });
            if (method === 'settings.set_publication_mode' && rejectPublication)
              throw { message: 'Publication mode update denied' };
            if (method === 'learning.sessions') return { items: history };
            if (method === 'learning.refine') return { job_id: 'tui-refine-job' };
            return core.call(String(method), input, owner);
          },
        },
      ),
  },
  ui: {
    router: {
      register: (value) => {
        page = value;
        return () => {};
      },
      current: () => route,
      navigate: () => {},
    },
    dialog: {
      alert: async (value) => {
        alerts.push(value);
      },
      select: async (value) => {
        selectionDialogs.push(value);
        const selected = selections.shift();
        if (selected !== undefined)
          assert.ok(value.options.some((option) => option.value === selected));
        return selected;
      },
      prompt: async () => prompts.shift(),
      confirm: async () => false,
    },
    model: {
      current: () => ({ providerID: 'test-provider', modelID: 'test-model', variant: 'high' }),
    },
    toast: { show: (value) => toasts.push(value) },
  },
  keymap: {
    layer: (factory) => {
      const layer = factory();
      const command = layer.commands?.find((item) => item.bind === 'ctrl+r');
      if (command) refresh = command.run;
      commands.push(
        ...(layer.commands ?? []).flatMap((c) => (c.slash?.name ? [c.slash.name] : [])),
      );
      for (const command of layer.commands ?? [])
        if (command.slash?.name) actions.set(command.slash.name, command.run);
    },
  },
};
let screen: Awaited<ReturnType<typeof testRender>> | undefined;
let cleanup: (() => void) | undefined;
try {
  await core.call(
    'skills.create',
    {
      files: {
        'SKILL.md':
          '---\nname: visible-tui-skill\ndescription: Verify rendered manager catalog.\n---\n\nChecked instruction.',
      },
      idempotency_key: 'tui-seed',
    },
    owner,
  );
  cleanup = await plugin.setup(context);
  assert.ok(commands.includes('skills-manager'));
  assert.ok(commands.includes('skills-jobs'));
  assert.ok(commands.includes('skills-refine'));
  assert.ok(commands.includes('skills-publication'));
  assert.ok(commands.includes('skills-settings'));
  screen = await testRender(() => page.render(), { width: 130, height: 30 });
  const frame = await screen.waitForFrame((frame) => frame.includes('visible-tui-skill'));
  assert.ok(frame.includes('Skill Curator'));
  assert.ok(frame.includes('Показано 1 из 1'));
  assert.ok(locations.length > 0);
  context.location = { directory };
  context.data.location.default = () => ({ directory: '/wrong-workspace' });
  const callsBefore = locations.length;
  refresh();
  await Promise.resolve();
  assert.equal(
    locations.length,
    callsBefore + 1,
    'Explicit route location must be used on refresh',
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const publication = actions.get('skills-publication')!;
  const settings = actions.get('skills-settings')!;
  const publicationRequests = () =>
    requests.filter((request) => request.method === 'settings.set_publication_mode');
  const initialSettings = (await core.call('settings.get', {}, owner)) as any;
  selections.push(undefined);
  await publication();
  assert.ok(selectionDialogs.at(-1)?.title.includes('ручная'));
  selections.push('manual');
  await publication();
  assert.equal(publicationRequests().length, 0, 'Cancel and unchanged mode must not mutate');
  selections.push('publication', 'auto');
  await settings();
  const automaticRequest = publicationRequests().at(-1)!;
  assert.equal(automaticRequest.input.publication_mode, 'auto');
  assert.equal(automaticRequest.input.expected_revision, initialSettings.revision);
  assert.ok(automaticRequest.input.idempotency_key);
  assert.equal(automaticRequest.input.auth, process.env.CURATOR_TUI_TEST_TOKEN);
  const automaticSettings = (await core.call('settings.get', {}, owner)) as any;
  assert.equal(automaticSettings.settings.approval.mode, 'auto');
  assert.equal(automaticSettings.settings.approval.allow_auto_create, true);
  assert.equal(automaticSettings.settings.approval.allow_auto_patch_managed_low_risk, true);
  assert.equal(toasts.at(-1)?.variant, 'success');
  assert.ok(toasts.at(-1)?.message.includes('Автоматическая публикация'));
  selections.push('auto');
  await publication();
  assert.ok(selectionDialogs.at(-1)?.title.includes('автоматическая'));
  assert.equal(publicationRequests().length, 1, 'An unchanged automatic mode must not mutate');
  selections.push('manual');
  await publication();
  const manualRequest = publicationRequests().at(-1)!;
  assert.equal(manualRequest.input.publication_mode, 'manual');
  assert.equal(manualRequest.input.expected_revision, automaticSettings.revision);
  const manualSettings = (await core.call('settings.get', {}, owner)) as any;
  assert.equal(manualSettings.settings.approval.mode, 'manual');
  assert.equal(manualSettings.settings.approval.allow_auto_create, false);
  assert.equal(manualSettings.settings.approval.allow_auto_patch_managed_low_risk, false);
  assert.ok(toasts.at(-1)?.message.includes('ручная публикация'));
  rejectPublication = true;
  selections.push('auto');
  await publication();
  assert.equal(toasts.at(-1)?.message, 'Publication mode update denied');
  assert.equal(toasts.at(-1)?.variant, 'error');
  const rejectedSettings = (await core.call('settings.get', {}, owner)) as any;
  assert.equal(rejectedSettings.revision, manualSettings.revision);
  assert.equal(rejectedSettings.settings.approval.mode, 'manual');
  rejectPublication = false;
  const mutationsBeforeSettingsCancel = publicationRequests().length;
  selections.push(undefined);
  await settings();
  assert.equal(publicationRequests().length, mutationsBeforeSettingsCancel);
  selections.push('json');
  prompts.push('{"limits":{"max_job_cost_usd":0.25}}');
  await settings();
  const jsonRequest = requests.filter((request) => request.method === 'settings.patch').at(-1)!;
  assert.equal(jsonRequest.input.expected_revision, manualSettings.revision);
  assert.deepEqual(jsonRequest.input.patch, { limits: { max_job_cost_usd: 0.25 } });
  assert.equal(
    ((await core.call('settings.get', {}, owner)) as any).settings.limits.max_job_cost_usd,
    0.25,
  );
  const refine = actions.get('skills-refine')!;
  route = { type: 'session', sessionID: 'ses_current' };
  selections.push('current', 'direct');
  prompts.push('  Reusable test troubleshooting  ');
  await refine();
  const current = requests.find((request) => request.method === 'learning.refine')!;
  assert.deepEqual(current.input.session_ids, ['ses_current']);
  assert.equal(current.input.reason, 'Reusable test troubleshooting');
  assert.deepEqual(current.input.execution, {
    mode: 'direct',
    provider: 'test-provider',
    model: 'test-model',
    variant: 'high',
  });
  assert.ok(current.input.idempotency_key);
  assert.equal(current.input.auth, process.env.CURATOR_TUI_TEST_TOKEN);
  assert.equal(toasts.at(-1)?.variant, 'success');
  assert.equal(requests.filter((request) => request.method === 'learning.sessions').length, 0);
  selections.push('history', 'ses_previous', 'session');
  prompts.push('');
  await refine();
  const previous = requests.filter((request) => request.method === 'learning.refine').at(-1)!;
  assert.deepEqual(previous.input.session_ids, ['ses_previous']);
  assert.equal(previous.input.execution.mode, 'session');
  assert.equal(previous.input.reason, undefined, 'Empty focus still starts a review');
  const started = requests.filter((request) => request.method === 'learning.refine').length;
  selections.push(undefined);
  await refine();
  selections.push('current');
  prompts.push(undefined);
  await refine();
  selections.push('current', undefined);
  prompts.push('');
  await refine();
  assert.equal(requests.filter((request) => request.method === 'learning.refine').length, started);
  route = { type: 'home' };
  history = [];
  await refine();
  assert.ok(alerts.at(-1)?.message.includes('нет доступных переписок'));
  history = [{ session_id: 'ses_previous', title: 'Previous completed conversation' }];
  selections.push('ses_previous', 'auto');
  prompts.push('');
  await refine();
  assert.equal(
    requests.filter((request) => request.method === 'learning.refine').length,
    started + 1,
  );
  deny = true;
  await refine();
  assert.equal(toasts.at(-1)?.message, 'Invalid capability token');
  assert.equal(toasts.at(-1)?.variant, 'error');
  route = { type: 'plugin', name: 'skills-manager' };
  refresh();
  const errorFrame = await screen.waitForFrame((frame) =>
    frame.includes('Invalid capability token'),
  );
  assert.ok(errorFrame.includes('Skill Curator'));
  console.log(
    'OpenTUI headless manager, publication controls and current/historical conversation refinement passed',
  );
} finally {
  await screen?.dispose();
  cleanup?.();
  await core.close();
  delete process.env.CURATOR_TUI_TEST_TOKEN;
  rmSync(dir, { recursive: true, force: true });
}
