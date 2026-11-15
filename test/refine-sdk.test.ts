import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode/plugin';
import plugin from '../src/server.js';
import { SkillCurator, type RpcInput } from '../src/rpc.js';
import type { Job } from '../src/jobs.js';
import type { Proposal } from '../src/types.js';

test('the real SDK scheduler reviews failed and successful tools after a final response and inherits its model', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'curator-refine-sdk-'));
  const tokenEnvironment = 'CURATOR_REFINE_SDK_TEST_TOKEN';
  const token = 'test-only-refine-sdk-capability-0123456789';
  process.env[tokenEnvironment] = token;
  let handlers: Record<string, (input: RpcInput, context: unknown) => Promise<unknown>> = {};
  let afterTool: (event: Record<string, unknown>) => unknown = () => {};
  const eventQueue: Array<Record<string, unknown>> = [];
  let wake: (() => void) | undefined;
  let completed = false;
  let generations = 0;
  const stateReads: string[] = [];
  const contextReads: string[] = [];
  const models: unknown[] = [];
  const quote = 'The project fixture resolved the failing check.';
  let reviewedSnapshot: { snapshot_id: string; content: string; evidence_kind: string } | undefined;
  const messages = [
    {
      type: 'user',
      content: [{ type: 'text', text: 'Use the project fixture, not a global one.' }],
    },
    {
      type: 'assistant',
      content: [
        {
          type: 'tool',
          id: 'failed-read',
          name: 'read',
          input: { path: 'global-fixture.json' },
          result: { error: 'ENOENT: the global fixture does not exist' },
        },
        { type: 'text', text: quote },
      ],
    },
  ];
  const context = {
    options: {
      token_env: tokenEnvironment,
      data_directory: join(directory, 'state'),
      workspace_id: 'sdk-refine-workspace',
    },
    location: { directory, workspaceID: 'sdk-refine-workspace' },
    skill: {
      list: async () => ({ data: [] }),
      transform: async () => ({ dispose: async () => {} }),
      reload: async () => {},
    },
    rpc: {
      register: async (definition: unknown, registered: typeof handlers) => {
        assert.equal(definition, SkillCurator);
        handlers = registered;
        return { dispose: async () => {}, events: { emit: async () => {} } };
      },
    },
    tool: {
      hook: async (name: string, handler: typeof afterTool) => {
        assert.equal(name, 'execute.after');
        afterTool = handler;
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        signal.addEventListener('abort', () => wake?.(), { once: true });
        while (!signal.aborted) {
          if (eventQueue.length > 0) {
            yield eventQueue.shift()!;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    experimental: {
      generate: {
        text: async ({ prompt, model }: { prompt: string; model: unknown }) => {
          generations++;
          models.push(model);
          const payload = JSON.parse(prompt);
          reviewedSnapshot = payload.snapshot;
          assert.equal(reviewedSnapshot!.evidence_kind, 'unverified_conversation');
          assert.ok(reviewedSnapshot!.content.includes('ENOENT'));
          assert.ok(reviewedSnapshot!.content.includes('Use the project fixture'));
          assert.ok(reviewedSnapshot!.content.includes(quote));
          return {
            text: JSON.stringify({
              candidates: [
                {
                  name: 'project-fixture-troubleshooting',
                  title: 'Use project fixtures for isolated checks',
                  problem: 'Global fixtures may be absent in isolated workspaces.',
                  solution:
                    'Resolve the fixture relative to the project before running its checks.',
                  conditions: ['A project-owned fixture is available.'],
                  evidence: [quote],
                  failures: ['The global fixture could not be read.'],
                  confidence: 0.9,
                  reusability_score: 0.9,
                  source_refs: [reviewedSnapshot!.snapshot_id],
                },
              ],
            }),
          };
        },
      },
    },
    session: {
      list: async () => ({ data: [] }),
      get: async ({ sessionID }: { sessionID: string }) => {
        stateReads.push(sessionID);
        return {
          id: sessionID,
          title: 'A fixture debugging conversation',
          location: { directory },
          time: { updated: completed ? 200 : 100, busy: 100, idle: completed ? 150 : undefined },
          outcome: completed ? 'succeeded' : undefined,
          model: { providerID: 'selected-provider', id: 'selected-model', variant: 'high' },
        };
      },
      context: async ({ sessionID }: { sessionID: string }) => {
        contextReads.push(sessionID);
        return messages;
      },
    },
  } as unknown as Plugin.Context;
  const errors = {
    error: (code: string, message: string) => {
      throw Object.assign(new Error(message), { code });
    },
  };
  const call = (method: string, input: RpcInput = {}) =>
    handlers[method]!({ ...input, auth: token, idempotency_key: randomUUID() }, errors);
  const emit = (type: string, sessionID: string, id: string) => {
    eventQueue.push({ type, id, location: { directory }, data: { sessionID } });
    wake?.();
  };
  let cleanup: Awaited<ReturnType<typeof plugin.setup>>;
  try {
    cleanup = await plugin.setup(context);
    await call('settings.patch', {
      expected_revision: 0,
      patch: {
        conversation_review: { enabled: true, every_n_actions: 2, min_age_sec: 0, debounce_sec: 0 },
        execution: { default_mode: 'direct' },
        curator: { enabled: false },
      },
    });
    emit('session.execution.started', 'source-session', 'start');
    await afterTool({
      id: 'failed-read',
      sessionID: 'source-session',
      status: 'failed',
      input: { path: 'global-fixture.json' },
      result: { error: 'ENOENT' },
    });
    await afterTool({
      id: 'successful-edit',
      sessionID: 'source-session',
      status: 'completed',
      input: { path: 'project.json' },
      result: { metadata: { exitCode: 0 } },
    });
    await afterTool({
      id: 'internal-tool',
      sessionID: 'ses_curator_internal',
      status: 'failed',
      input: {},
      result: {},
    });
    emit('session.execution.succeeded', 'ses_curator_internal', 'internal-done');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(generations, 0, 'Tool activity must not start a review during the response');
    assert.deepEqual(((await call('jobs.list')) as { items: unknown[] }).items, []);
    completed = true;
    emit('session.execution.succeeded', 'source-session', 'response-done');
    const deadline = Date.now() + 2000;
    let jobs: Job[] = [];
    while (Date.now() < deadline) {
      jobs = ((await call('jobs.list')) as { items: Job[] }).items;
      if (jobs.some((job) => job.status === 'completed')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.status, 'completed', JSON.stringify(jobs[0]));
    assert.equal(jobs[0]!.payload.review, true);
    assert.equal(generations, 1);
    assert.ok(stateReads.length >= 3, 'Native idle state and both snapshot boundaries were read');
    assert.ok(stateReads.every((sessionID) => sessionID === 'source-session'));
    assert.deepEqual(contextReads, ['source-session']);
    assert.deepEqual(models, [
      { id: 'selected-model', providerID: 'selected-provider', variant: 'high' },
    ]);
    const proposals = ((await call('proposals.list')) as { items: Proposal[] }).items;
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.operation, 'create');
    assert.equal(
      proposals[0]!.status,
      'applied',
      'Fresh-install publication applies supported results automatically',
    );
    assert.equal(
      jobs[0]!.cost_known,
      false,
      'SDK text-only generation does not provide a known actual cost',
    );
    assert.ok(proposals[0]!.source_refs.includes(reviewedSnapshot!.snapshot_id));
    assert.equal(((await call('skills.list')) as { items: unknown[] }).items.length, 1);
  } finally {
    await cleanup?.();
    delete process.env[tokenEnvironment];
    rmSync(directory, { recursive: true, force: true });
  }
});
