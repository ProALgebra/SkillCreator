import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../src/server.js';
import type { Plugin } from '@opencode/plugin';
import { SkillCurator, outputSchemas } from '../src/rpc.js';
import type { RpcInput } from '../src/rpc.js';
import { pack, fixture, owner } from './helpers.js';

test('OpenCode SDK adapter registers RPC, discovers skills, reloads published skills and cleans up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'curator-sdk-'));
  const token = 'test-only-capability-token-'.repeat(2);
  process.env.CURATOR_SDK_TEST_TOKEN = token;
  let handlers: Record<string, (input: RpcInput, context: unknown) => Promise<unknown>> = {};
  let transform: (editor: unknown) => void = () => {};
  let reloads = 0;
  let disposed = 0;
  const registry: Record<string, unknown>[] = [];
  const editor = {
    list: () => registry,
    remove: (id: string) => {
      const index = registry.findIndex((s) => s.id === id);
      if (index >= 0) registry.splice(index, 1);
    },
    add: (s: Record<string, unknown>) => registry.push(s),
  };
  const context = {
    options: {
      token_env: 'CURATOR_SDK_TEST_TOKEN',
      data_directory: join(dir, 'state'),
      workspace_id: 'sdk-workspace',
    },
    location: { directory: dir, workspaceID: 'sdk-workspace' },
    skill: {
      list: async () => ({ data: [] }),
      transform: async (fn: (editor: unknown) => void) => {
        transform = fn;
        fn(editor);
        return {
          dispose: async () => {
            disposed++;
          },
        };
      },
      reload: async () => {
        reloads++;
        transform(editor);
      },
    },
    rpc: {
      register: async (definition: unknown, registered: typeof handlers) => {
        assert.equal(definition, SkillCurator);
        handlers = registered;
        return {
          dispose: async () => {
            disposed++;
          },
          events: {
            emit: async () => {
              throw new Error('Do not broadcast private events');
            },
          },
        };
      },
    },
    tool: {
      hook: async () => ({
        dispose: async () => {
          disposed++;
        },
      }),
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
    },
    experimental: { generate: { text: async () => ({ text: '{"updates":[]}' }) } },
    session: {},
  } as unknown as Plugin.Context;
  let cleanup: Awaited<ReturnType<typeof plugin.setup>>;
  try {
    cleanup = await plugin.setup(context);
    const errorFactory = {
      error: (code: string, message: string) => {
        throw Object.assign(new Error(message), { code });
      },
    };
    await assert.rejects(handlers['skills.list']!({}, errorFactory), /Invalid capability token/);
    const created = (await handlers['skills.create']!(
      { auth: token, files: pack('sdk-created'), idempotency_key: 'sdk-create' },
      errorFactory,
    )) as { skill_id: string };
    assert.ok(created.skill_id);
    assert.ok(reloads >= 2);
    assert.equal(registry[0]!.name, 'sdk-created');
    outputSchemas['skills.create'].parse(created);
    const preview = await handlers['curator.review']!(
      { auth: token, dry_run: true, execution: { mode: 'direct' } },
      errorFactory,
    );
    outputSchemas['curator.review'].parse(preview);
    const job = await handlers['executors.test']!(
      {
        auth: token,
        skill_ids: [created.skill_id],
        execution: { mode: 'direct' },
        idempotency_key: 'sdk-job',
      },
      errorFactory,
    );
    assert.deepEqual(
      job,
      JSON.parse(JSON.stringify(job)),
      'RPC output must contain only JSON values',
    );
    await cleanup?.();
    cleanup = undefined;
    assert.equal(disposed, 3);
  } finally {
    await cleanup?.();
    delete process.env.CURATOR_SDK_TEST_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('typed public output schemas validate real catalog and job responses', async (t) => {
  const { call } = fixture(t, {
    executors: { direct: async () => ({ output: { updates: [] }, cost_usd: 0 }) },
  });
  const created = await call('skills.create', { files: pack('contract') });
  outputSchemas['skills.create'].parse(created);
  outputSchemas['skills.list'].parse(await call('skills.list'));
  outputSchemas['settings.get'].parse(await call('settings.get'));
  outputSchemas['curator.review'].parse(
    await call('curator.review', { execution: { mode: 'direct' } }),
  );
  outputSchemas['curator.review'].parse(
    await call('curator.review', { execution: { mode: 'direct' }, dry_run: true }),
  );
});
