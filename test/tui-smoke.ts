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
const locations: string[] = [];
const directory = '/workspace/curator-tui-test';
let deny = false;
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
      current: () => ({ type: 'plugin', name: 'skills-manager' }),
      navigate: () => {},
    },
    dialog: {
      alert: async () => {},
      select: async () => undefined,
      prompt: async () => undefined,
      confirm: async () => false,
    },
    toast: { show: () => {} },
  },
  keymap: {
    layer: (factory) => {
      const layer = factory();
      const command = layer.commands?.find((item) => item.bind === 'ctrl+r');
      if (command) refresh = command.run;
      commands.push(
        ...(layer.commands ?? []).flatMap((c) => (c.slash?.name ? [c.slash.name] : [])),
      );
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
  deny = true;
  refresh();
  const errorFrame = await screen.waitForFrame((frame) =>
    frame.includes('Invalid capability token'),
  );
  assert.ok(errorFrame.includes('Skill Curator'));
  console.log('OpenTUI headless manager: actual frame, catalog and slash commands passed');
} finally {
  await screen?.dispose();
  cleanup?.();
  await core.close();
  delete process.env.CURATOR_TUI_TEST_TOKEN;
  rmSync(dir, { recursive: true, force: true });
}
