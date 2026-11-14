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
let viewer = false;
let deferCatalog: Promise<void> | undefined;
let deferSelection: Promise<void> | undefined;
let rejectPublication = false;
let rejectOptimization = false;
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
const managerLayers: Array<{
  enabled?: () => boolean;
  commands: Array<{
    bind?: string;
    enabled?: () => boolean;
    run: () => unknown;
  }>;
}> = [];
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
            if (method === 'skills.list' && deferCatalog) await deferCatalog;
            if (method === 'manager.refresh' && viewer)
              throw {
                type: 'skill-curator.v1.forbidden',
                message: 'Insufficient permissions',
                data: { code: 'forbidden' },
              };
            if (method === 'settings.set_publication_mode' && rejectPublication)
              throw { message: 'Publication mode update denied' };
            if (method === 'learning.sessions') return { items: history };
            if (method === 'learning.refine') return { job_id: 'tui-refine-job' };
            if (method === 'curator.optimize') {
              if (rejectOptimization) throw { message: 'Optimization budget exhausted' };
              return input.dry_run
                ? {
                    batches: [{ skill_ids: ['skill-a', 'skill-b'] }],
                    skipped: [],
                    total: 2,
                    next_cursor: null,
                  }
                : {
                    run_id: 'tui-optimization',
                    jobs: [{ job_id: 'tui-optimize-job', status: 'queued' }],
                    skipped: [],
                    next_cursor: null,
                  };
            }
            if (method === 'curator.status')
              return {
                reports: [
                  { proposal_ids: ['tui-optimizer-applied'], active_before: 4, active_after: 2 },
                ],
              };
            if (method === 'proposals.get' && input.proposal_id === 'tui-optimizer-applied')
              return { proposal_id: input.proposal_id, revision: 7, status: 'applied' };
            if (method === 'proposals.get' && input.proposal_id === 'tui-optimizer-pending')
              return { proposal_id: input.proposal_id, revision: 1, status: 'pending' };
            if (method === 'curator.rollback')
              return { proposal_id: 'tui-optimizer-inverse', status: 'pending', automatic: false };
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
        if (deferSelection) await deferSelection;
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
      if (command) {
        refresh = command.run;
        managerLayers.push(layer);
      }
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
const managerKey = async (bind: string) => {
  const layer = managerLayers.at(-1)!;
  if (layer.enabled && !layer.enabled()) return;
  const command = layer.commands.find((item) => item.bind === bind);
  assert.ok(command, 'Manager binding must exist: ' + bind);
  if (!command.enabled || command.enabled()) await command.run();
  await screen?.flush();
};
const clickText = async (text: string) => {
  const frame = screen!.captureCharFrame().split('\n');
  const y = frame.findIndex((line) => line.includes(text));
  assert.ok(y >= 0, 'Clickable text must be visible: ' + text);
  await screen!.mockMouse.click(frame[y]!.indexOf(text), y);
  await screen!.flush();
};
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
  const second = (await core.call(
    'skills.create',
    {
      files: {
        'SKILL.md':
          '---\nname: zz-tui-skill\ndescription: Another manager selection.\n---\n\nSecond instruction.',
      },
      idempotency_key: 'tui-seed-second',
    },
    owner,
  )) as any;
  cleanup = await plugin.setup(context);
  assert.ok(commands.includes('skills-manager'));
  assert.ok(commands.includes('skills-jobs'));
  assert.ok(commands.includes('skills-refine'));
  assert.ok(commands.includes('skills-publication'));
  assert.ok(commands.includes('skills-settings'));
  assert.ok(commands.includes('skills-optimize'));
  screen = await testRender(() => page.render(), { width: 130, height: 30 });
  const frame = await screen.waitForFrame((frame) => frame.includes('visible-tui-skill'));
  assert.ok(frame.includes('Skill Curator'));
  assert.ok(frame.includes('Показано 2 из 2'));
  assert.ok(frame.includes('Открыть действия · visible-tui-skill'));
  assert.equal(
    requests.filter((request) => request.method === 'manager.refresh').length,
    1,
    'Opening the manager synchronizes discovered skills once',
  );
  await managerKey('down');
  await screen.waitForFrame((frame) => frame.includes('Открыть действия · zz-tui-skill'));
  await managerKey('enter');
  assert.equal(selectionDialogs.at(-1)?.title, 'zz-tui-skill · revision 1');
  await managerKey('up');
  await screen.waitForFrame((frame) => frame.includes('Открыть действия · visible-tui-skill'));
  await clickText('zz-tui-skill · r1');
  await screen.waitForFrame((frame) => frame.includes('Открыть действия · zz-tui-skill'));

  const updated = (await core.call(
    'skills.update',
    {
      skill_id: second.skill_id,
      expected_revision: second.revision,
      files: {
        'SKILL.md': second.files['SKILL.md'].replace('Second instruction.', 'Updated instruction.'),
      },
      idempotency_key: 'tui-update-selected',
    },
    owner,
  )) as any;
  // An action also reads the current skill when the next poll has not happened yet.
  await managerKey('enter');
  assert.equal(selectionDialogs.at(-1)?.title, 'zz-tui-skill · revision 2');
  await screen.waitForFrame((frame) => frame.includes('Updated instruction.'));

  let closeDialog!: () => void;
  deferSelection = new Promise((resolve) => (closeDialog = resolve));
  const dialogsBefore = selectionDialogs.length;
  const pendingAction = managerKey('enter');
  await screen.waitFor(() => selectionDialogs.length === dialogsBefore + 1);
  await managerKey('up');
  await managerKey('enter');
  assert.equal(selectionDialogs.length, dialogsBefore + 1, 'Dialogs must own keyboard input');
  closeDialog();
  await pendingAction;
  deferSelection = undefined;
  assert.ok(screen.captureCharFrame().includes('Открыть действия · zz-tui-skill'));

  await managerKey('ctrl+f');
  await screen.mockInput.typeText('zz-tui');
  await screen.waitForFrame((frame) => frame.includes('Показано 1 из 1'));
  const beforeSearchEnter = selectionDialogs.length;
  screen.mockInput.pressEnter();
  await screen.flush();
  assert.equal(selectionDialogs.length, beforeSearchEnter, 'Search Enter only focuses the results');
  await managerKey('enter');
  assert.equal(selectionDialogs.at(-1)?.title, 'zz-tui-skill · revision 2');
  await managerKey('ctrl+f');
  await screen.mockInput.typeText('-missing');
  const emptySearch = await screen.waitForFrame((frame) => frame.includes('найдены. Измените'));
  assert.ok(emptySearch.includes('Показано 0 из 0'));
  assert.ok(!emptySearch.includes('Выберите навык.'));
  assert.ok(!emptySearch.includes('Открыть действия'));
  await screen.mockInput.pressKeys(
    Array.from({ length: 'zz-tui-missing'.length }, () => 'BACKSPACE'),
  );
  screen.mockInput.pressEnter();
  await screen.waitForFrame((frame) => frame.includes('Показано 2 из 2'));
  await clickText('archived');
  const emptyState = await screen.waitForFrame((frame) =>
    frame.includes('В разделе archived нет навыков'),
  );
  assert.ok(emptyState.includes('Показано 0 из 0'));
  assert.ok(!emptyState.includes('Открыть действия'));
  await clickText('active');
  await screen.waitForFrame((frame) => frame.includes('Показано 2 из 2'));

  let finishLoad!: () => void;
  deferCatalog = new Promise((resolve) => (finishLoad = resolve));
  const loadingRefresh = managerKey('ctrl+r');
  await screen.waitForFrame((frame) => frame.includes('Загрузка каталога…'));
  const beforeLoadingEnter = selectionDialogs.length;
  await managerKey('enter');
  assert.equal(selectionDialogs.length, beforeLoadingEnter);
  finishLoad();
  await loadingRefresh;
  deferCatalog = undefined;
  viewer = true;
  await managerKey('ctrl+r');
  const readonlyFrame = await screen.waitForFrame((frame) => frame.includes('Режим чтения:'));
  assert.ok(readonlyFrame.includes('Показано 2 из 2'));
  viewer = false;
  await managerKey('ctrl+r');

  await managerKey('down');
  await core.call(
    'skills.archive',
    {
      skill_id: second.skill_id,
      expected_revision: updated.revision,
      idempotency_key: 'tui-archive-selected',
    },
    owner,
  );
  await managerKey('ctrl+r');
  await screen.waitForFrame((frame) => frame.includes('Показано 1 из 1'));
  assert.ok(screen.captureCharFrame().includes('Открыть действия · visible-tui-skill'));
  const archived = (await core.call('skills.get', { skill_id: second.skill_id }, owner)) as any;
  await core.call(
    'skills.restore',
    {
      skill_id: archived.skill_id,
      expected_revision: archived.revision,
      idempotency_key: 'tui-restore-selected',
    },
    owner,
  );
  await managerKey('ctrl+r');

  for (let index = 0; index < 16; index++)
    await core.call(
      'skills.create',
      {
        files: {
          'SKILL.md':
            '---\nname: scrolling-tui-' +
            index +
            '\ndescription: Verify selection scrolling.\n---\n\nKeep rows visible.',
        },
        idempotency_key: 'tui-scroll-' + index,
      },
      owner,
    );
  await managerKey('ctrl+r');
  for (let index = 0; index < 20; index++) await managerKey('down');
  const scrolled = await screen.waitForFrame((frame) => frame.includes('› zz-tui-skill'));
  assert.ok(scrolled.includes('Открыть действия · zz-tui-skill'));
  for (let index = 0; index < 20; index++) await managerKey('up');
  await screen.waitForFrame((frame) => frame.includes('› scrolling-tui-0'));
  assert.ok(locations.length > 0);
  context.location = { directory };
  context.data.location.default = () => ({ directory: '/wrong-workspace' });
  const callsBefore = locations.length;
  await refresh();
  assert.equal(
    locations.length,
    callsBefore + 2,
    'Refresh must synchronize discovery and read the explicit route location',
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
  const optimize = actions.get('skills-optimize')!;
  const optimizeRequests = () =>
    requests.filter((request) => request.method === 'curator.optimize');
  selections.push(undefined);
  await optimize();
  selections.push('run', undefined);
  await optimize();
  assert.equal(optimizeRequests().length, 0, 'Cancelled optimization must not launch a job');
  selections.push('run', 'direct');
  await optimize();
  const optimization = optimizeRequests().at(-1)!;
  assert.deepEqual(optimization.input.execution, {
    mode: 'direct',
    provider: 'test-provider',
    model: 'test-model',
    variant: 'high',
  });
  assert.ok(optimization.input.idempotency_key);
  assert.equal(optimization.input.auth, process.env.CURATOR_TUI_TEST_TOKEN);
  assert.ok(alerts.at(-1)?.message.includes('tui-optimize-job'));
  const jobsBeforePreview = ((await core.call('jobs.list', {}, owner)) as any).items;
  selections.push('preview');
  await optimize();
  const preview = optimizeRequests().at(-1)!;
  assert.equal(preview.input.dry_run, true);
  assert.equal(preview.input.idempotency_key, undefined);
  assert.ok(alerts.at(-1)?.message.includes('skill-a'));
  assert.deepEqual(((await core.call('jobs.list', {}, owner)) as any).items, jobsBeforePreview);
  selections.push('status');
  await optimize();
  assert.ok(alerts.at(-1)?.message.includes('tui-optimizer-applied'));
  const beforeSchedule = (await core.call('settings.get', {}, owner)) as any;
  selections.push('schedule');
  prompts.push('{"interval_hours":24,"llm_review_enabled":true}');
  await optimize();
  const schedule = requests.filter((request) => request.method === 'settings.patch').at(-1)!;
  assert.equal(schedule.input.expected_revision, beforeSchedule.revision);
  assert.deepEqual(schedule.input.patch, {
    curator: { interval_hours: 24, llm_review_enabled: true },
  });
  const afterSchedule = (await core.call('settings.get', {}, owner)) as any;
  assert.equal(afterSchedule.settings.curator.interval_hours, 24);
  assert.equal(afterSchedule.settings.curator.llm_review_enabled, true);
  assert.deepEqual(afterSchedule.settings.approval, beforeSchedule.settings.approval);
  const settingsRequestsBeforeCancel = requests.filter(
    (request) => request.method === 'settings.patch',
  ).length;
  selections.push('schedule');
  prompts.push(undefined);
  await optimize();
  selections.push('schedule');
  prompts.push(JSON.stringify(afterSchedule.settings.curator));
  await optimize();
  assert.equal(
    requests.filter((request) => request.method === 'settings.patch').length,
    settingsRequestsBeforeCancel,
  );
  selections.push('schedule');
  prompts.push('[]');
  await optimize();
  assert.equal(toasts.at(-1)?.variant, 'error');
  assert.ok(toasts.at(-1)?.message.includes('JSON-объектом'));
  selections.push('auto_merge', 'auto');
  await optimize();
  const mergePolicy = requests.filter((request) => request.method === 'settings.patch').at(-1)!;
  assert.equal(mergePolicy.input.expected_revision, afterSchedule.revision);
  assert.deepEqual(mergePolicy.input.patch, { approval: { allow_auto_merge: true } });
  const afterMergePolicy = (await core.call('settings.get', {}, owner)) as any;
  assert.equal(afterMergePolicy.settings.approval.allow_auto_merge, true);
  assert.equal(
    afterMergePolicy.settings.approval.mode,
    'manual',
    'Merge permission must preserve the publication mode',
  );
  assert.ok(toasts.at(-1)?.message.includes('/skills-publication'));
  const beforeUnchangedMerge = requests.filter(
    (request) => request.method === 'settings.patch',
  ).length;
  selections.push('auto_merge', 'auto');
  await optimize();
  selections.push('auto_merge', undefined);
  await optimize();
  assert.equal(
    requests.filter((request) => request.method === 'settings.patch').length,
    beforeUnchangedMerge,
  );
  selections.push('auto_merge', 'manual');
  await optimize();
  assert.equal(
    ((await core.call('settings.get', {}, owner)) as any).settings.approval.allow_auto_merge,
    false,
  );
  const beforeAutomation = (await core.call('settings.get', {}, owner)) as any;
  selections.push('automation', 'disabled');
  await optimize();
  const disabledAutomation = requests
    .filter((request) => request.method === 'settings.patch')
    .at(-1)!;
  assert.equal(disabledAutomation.input.expected_revision, beforeAutomation.revision);
  assert.deepEqual(disabledAutomation.input.patch, {
    curator: { enabled: false, llm_review_enabled: false },
  });
  selections.push('automation', 'lifecycle');
  await optimize();
  const lifecycleAutomation = (await core.call('settings.get', {}, owner)) as any;
  assert.equal(lifecycleAutomation.settings.curator.enabled, true);
  assert.equal(lifecycleAutomation.settings.curator.llm_review_enabled, false);
  selections.push('automation', 'optimize');
  await optimize();
  const enabledAutomation = (await core.call('settings.get', {}, owner)) as any;
  assert.equal(enabledAutomation.settings.curator.enabled, true);
  assert.equal(enabledAutomation.settings.curator.llm_review_enabled, true);
  assert.equal(
    enabledAutomation.settings.curator.interval_hours,
    beforeAutomation.settings.curator.interval_hours,
  );
  assert.deepEqual(enabledAutomation.settings.approval, beforeAutomation.settings.approval);
  const beforeAutomationNoop = requests.filter(
    (request) => request.method === 'settings.patch',
  ).length;
  selections.push('automation', undefined);
  await optimize();
  selections.push('automation', 'optimize');
  await optimize();
  assert.equal(
    requests.filter((request) => request.method === 'settings.patch').length,
    beforeAutomationNoop,
  );
  selections.push('pause');
  await optimize();
  const pauseRequest = requests.filter((request) => request.method === 'system.pause').at(-1)!;
  assert.equal(pauseRequest.input.subsystem, 'curator');
  assert.equal(((await core.call('system.status', {}, owner)) as any).paused.curator, true);
  selections.push('resume');
  await optimize();
  assert.equal(
    requests.filter((request) => request.method === 'system.resume').at(-1)!.input.subsystem,
    'curator',
  );
  assert.equal(((await core.call('system.status', {}, owner)) as any).paused.curator, false);
  selections.push('rollback');
  prompts.push('  tui-optimizer-applied  ');
  await optimize();
  const rollback = requests.filter((request) => request.method === 'curator.rollback').at(-1)!;
  assert.equal(rollback.input.proposal_id, 'tui-optimizer-applied');
  assert.equal(rollback.input.expected_revision, 7);
  assert.ok(rollback.input.idempotency_key);
  assert.ok(alerts.at(-1)?.message.includes('tui-optimizer-inverse'));
  assert.equal(
    requests.filter((request) => request.method === 'proposals.apply').length,
    0,
    'Prepared rollback needs separate approval',
  );
  selections.push('rollback');
  prompts.push(undefined);
  await optimize();
  selections.push('rollback');
  prompts.push('tui-optimizer-pending');
  await optimize();
  assert.equal(requests.filter((request) => request.method === 'curator.rollback').length, 1);
  assert.equal(toasts.at(-1)?.variant, 'error');
  rejectOptimization = true;
  selections.push('run', 'session');
  await optimize();
  assert.equal(toasts.at(-1)?.message, 'Optimization budget exhausted');
  assert.equal(toasts.at(-1)?.variant, 'error');
  rejectOptimization = false;
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
    'OpenTUI headless manager, publication controls, optimizer and current/historical conversation refinement passed',
  );
} finally {
  await screen?.dispose();
  cleanup?.();
  await core.close();
  delete process.env.CURATOR_TUI_TEST_TOKEN;
  rmSync(dir, { recursive: true, force: true });
}
