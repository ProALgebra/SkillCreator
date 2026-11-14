import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CuratorScheduler,
  curatorScheduleStatus,
  type CuratorDrainOptions,
} from '../src/curator-scheduler.js';
import { readCuratorSessionState } from '../src/server.js';
import { defaults } from '../src/settings.js';
import { Store } from '../src/store.js';
import type { Execution, Settings } from '../src/types.js';
import { scope } from './helpers.js';

const start = Date.UTC(2026, 10, 14, 12);
const hour = 3_600_000;
function settings(patch: Partial<Settings['curator']> = {}): Settings {
  const result = structuredClone(defaults);
  result.curator = {
    ...result.curator,
    enabled: true,
    interval_hours: 1,
    min_idle_hours: 0,
    llm_review_enabled: true,
    ...patch,
  };
  return result;
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'curator-schedule-'));
  const path = join(directory, 'curator.sqlite');
  let store = new Store(path);
  let scheduler = new CuratorScheduler(store, scope, start);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const lifecycle: string[] = [];
  const optimize: Array<{ key: string; execution?: Execution }> = [];
  const options: CuratorDrainOptions = {
    settings: settings(),
    paused: false,
    now: start + hour,
    readState: async () => ({ idle: true }),
    lifecycle: async (key) => lifecycle.push(key),
    optimize: async (key, execution) => {
      optimize.push({ key, execution });
      return { run_id: 'run-' + optimize.length, jobs: [{ job_id: 'job-' + optimize.length }] };
    },
  };
  return {
    get store() {
      return store;
    },
    get scheduler() {
      return scheduler;
    },
    status: () => curatorScheduleStatus(store, scope, options.settings, options.now),
    options,
    lifecycle,
    optimize,
    restart: (at = start + hour / 2) => {
      store.close();
      store = new Store(path);
      scheduler = new CuratorScheduler(store, scope, at);
    },
  };
}

test('curator schedule survives reload and waits for both interval and idle time', async (t) => {
  const f = fixture(t);
  f.options.settings = settings({ min_idle_hours: 2 });
  f.scheduler.activity('source', 'reply-done', start + hour / 2);
  f.restart(start + 2 * hour);
  assert.equal(f.status().last_run_at, start);
  assert.equal(f.status().last_activity_at, start + hour / 2);
  assert.equal(f.status().next_run_at, start + 2.5 * hour);
  await f.scheduler.drain({ ...f.options, now: start + 2.5 * hour - 1 });
  assert.equal(f.lifecycle.length, 0);
  await f.scheduler.drain({ ...f.options, now: start + 2.5 * hour });
  assert.equal(f.lifecycle.length, 1);
  assert.equal(f.optimize.length, 1);
  assert.equal(f.status().last_run_at, start + 2.5 * hour);
  f.restart(start + 3 * hour);
  await f.scheduler.drain({ ...f.options, now: start + 3 * hour });
  assert.equal(f.optimize.length, 1, 'reloading cannot reset or duplicate a completed cycle');
});

test('disabled and paused curator schedules never inspect sessions or queue work', async (t) => {
  const f = fixture(t);
  let reads = 0;
  const readState = async () => {
    reads++;
    return { idle: true };
  };
  const disabled = settings();
  disabled.enabled = false;
  for (const options of [
    { ...f.options, paused: true },
    { ...f.options, settings: disabled },
    { ...f.options, settings: settings({ enabled: false }) },
  ])
    await f.scheduler.drain({ ...options, readState });
  assert.equal(reads, 0);
  assert.equal(f.optimize.length, 0);
  await f.scheduler.drain({ ...f.options, readState: async () => ({ idle: false }) });
  assert.equal(f.lifecycle.length, 0, 'a native busy verdict also defers lifecycle mutations');
});

test('lifecycle maintenance continues without LLM review and its pass is consumed once', async (t) => {
  const f = fixture(t);
  f.options.settings = settings({ llm_review_enabled: false });
  await f.scheduler.drain(f.options);
  await f.scheduler.drain(f.options);
  f.restart();
  await f.scheduler.drain(f.options);
  assert.equal(f.lifecycle.length, 1);
  assert.equal(f.optimize.length, 0);
  assert.equal(f.status().pending, false);
  assert.deepEqual(f.status().job_ids, []);
});

test('automatic optimization inherits the latest foreground model unless explicitly configured', async (t) => {
  const f = fixture(t);
  const execution = { provider: 'source-provider', model: 'selected-model', variant: 'high' };
  await f.scheduler.drain({ ...f.options, readState: async () => ({ idle: true, execution }) });
  assert.deepEqual(f.optimize[0]?.execution, execution);
  f.options.settings = settings({
    provider: 'configured-provider',
    model: 'review-model',
    variant: 'low',
  });
  await f.scheduler.drain({
    ...f.options,
    now: start + 2 * hour,
    readState: async () => ({ idle: true, execution }),
  });
  assert.deepEqual(f.optimize[1]?.execution, {
    provider: 'configured-provider',
    model: 'review-model',
    variant: 'low',
  });
});

test('pending optimization including unknown outcomes blocks another scheduled cycle only in its scope', async (t) => {
  const f = fixture(t);
  for (const status of ['queued', 'running', 'waiting_executor', 'unknown_outcome']) {
    f.store.put('jobs', 'existing', { ...scope, operation: 'optimize', payload: {}, status });
    await f.scheduler.drain(f.options);
  }
  assert.equal(f.lifecycle.length, 0);
  f.store.put('jobs', 'existing', {
    ...scope,
    operation: 'optimize',
    payload: {},
    status: 'completed',
  });
  f.store.put('jobs', 'another-workspace', {
    ...scope,
    workspace_id: 'other',
    operation: 'optimize',
    payload: {},
    status: 'unknown_outcome',
  });
  f.store.put('jobs', 'learning', {
    ...scope,
    operation: 'learning',
    payload: {},
    status: 'queued',
  });
  await f.scheduler.drain(f.options);
  assert.equal(f.optimize.length, 1);
});

test('native timestamps recover missed activity, and live events invalidate an in-flight idle lookup', async (t) => {
  const f = fixture(t);
  f.options.settings = settings({ min_idle_hours: 1 });
  const readState = async () => ({ idle: true, last_activity_at: start + hour / 2 });
  await f.scheduler.drain({ ...f.options, readState });
  assert.equal(f.status().last_activity_at, start + hour / 2);
  assert.equal(f.lifecycle.length, 0);
  await f.scheduler.drain({
    ...f.options,
    now: start + 1.5 * hour,
    readState: async () => {
      f.scheduler.activity('source', 'new-request', start + 1.5 * hour);
      return { idle: true };
    },
  });
  assert.equal(f.lifecycle.length, 0);
  await f.scheduler.drain({ ...f.options, now: start + 2.5 * hour });
  assert.equal(f.optimize.length, 1);
});

test('internal and repeated events cannot keep moving the idle boundary across reload', async (t) => {
  const f = fixture(t);
  f.scheduler.activity('source', 'completed', start + 10);
  f.store.put('control', 'internal:hidden', { internal: true });
  f.scheduler.activity('hidden', 'internal-call', start + hour);
  f.scheduler.activity('ses_curator_generated', 'internal-call', start + hour);
  f.restart();
  f.scheduler.activity('source', 'completed', start + hour);
  assert.equal(f.status().last_activity_at, start + 10);
  await f.scheduler.drain(f.options);
  assert.equal(f.optimize.length, 1);
});

test('activity during lifecycle maintenance defers model work while preserving the completed lifecycle stage', async (t) => {
  const f = fixture(t);
  f.options.settings = settings({ min_idle_hours: 1 });
  await f.scheduler.drain({
    ...f.options,
    lifecycle: async (key) => {
      await f.options.lifecycle(key);
      f.scheduler.activity('source', 'new-response', start + hour);
    },
  });
  assert.equal(f.lifecycle.length, 1);
  assert.equal(f.optimize.length, 0);
  assert.equal(f.status().pending, true);
  f.restart();
  await f.scheduler.drain({ ...f.options, now: start + 2 * hour });
  assert.equal(f.lifecycle.length, 1);
  assert.equal(f.optimize.length, 1);
});

test('concurrent ticks do not duplicate a scheduled pass', async (t) => {
  const f = fixture(t);
  let finish: (() => void) | undefined;
  const lookup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = f.scheduler.drain({
    ...f.options,
    readState: async () => {
      await lookup;
      return { idle: true };
    },
  });
  await f.scheduler.drain(f.options);
  assert.equal(f.optimize.length, 0);
  finish!();
  await first;
  assert.equal(f.optimize.length, 1);
});

test('known preacceptance rejection rotates only the failed stage key after durable backoff', async (t) => {
  const f = fixture(t);
  const attempts: Array<{ key: string; execution?: Execution }> = [];
  const execution = { provider: 'source-provider', model: 'first-model' };
  await f.scheduler.drain({
    ...f.options,
    readState: async () => ({ idle: true, execution }),
    optimize: async (key, model) => {
      attempts.push({ key, execution: model });
      throw Object.assign(new Error('private provider authorization header'), {
        code: 'budget_exceeded',
      });
    },
  });
  assert.equal(f.status().last_error?.code, 'budget_exceeded');
  f.restart();
  await f.scheduler.drain({ ...f.options, now: start + hour + 29_999 });
  assert.equal(f.optimize.length, 0);
  await f.scheduler.drain({
    ...f.options,
    now: start + hour + 30_000,
    readState: async () => ({
      idle: true,
      execution: { provider: 'new-provider', model: 'new-model' },
    }),
  });
  assert.equal(f.optimize.length, 1);
  assert.notEqual(attempts[0]?.key, f.optimize[0]?.key);
  assert.deepEqual(
    f.optimize[0]?.execution,
    execution,
    'the pending cycle retains its model selection',
  );
  assert.equal(f.lifecycle.length, 1);
  assert.ok(!JSON.stringify(f.store.all('events')).includes('private provider'));
});

test('uncertain submission preserves its idempotency key after restart and exposes reconciliation state', async (t) => {
  const f = fixture(t);
  let acceptedKey = '';
  await f.scheduler.drain({
    ...f.options,
    optimize: async (key) => {
      acceptedKey = key;
      throw Object.assign(new Error('lost response carrying private content'), {
        code: 'unknown_outcome',
      });
    },
  });
  assert.equal(f.status().last_error?.reconciliation_required, true);
  f.restart();
  await f.scheduler.drain({ ...f.options, now: start + hour + 30_000 });
  assert.equal(f.optimize[0]?.key, acceptedKey);
  assert.deepEqual(f.status().job_ids, ['job-1']);
  assert.equal(f.status().run_id, 'run-1');
  assert.equal(f.status().last_error, undefined);
  assert.equal(f.lifecycle.length, 1);
  assert.ok(!JSON.stringify(f.store.all('events')).includes('private content'));
});

test('a refused lifecycle is retried with a new key before optimization', async (t) => {
  const f = fixture(t);
  let refused = '';
  await f.scheduler.drain({
    ...f.options,
    lifecycle: async (key) => {
      refused = key;
      throw Object.assign(new Error('local rate limit'), { code: 'rate_limited' });
    },
  });
  assert.equal(f.optimize.length, 0);
  await f.scheduler.drain({ ...f.options, now: start + hour + 30_000 });
  assert.notEqual(f.lifecycle[0], refused);
  assert.equal(f.optimize.length, 1);
});

test('native curator idle lookup paginates, includes busy children and inherits only foreground models', async () => {
  const directory = '/workspace';
  const info = (id: string, updated: number, extra: Record<string, unknown> = {}) => ({
    id,
    location: { directory },
    time: { updated, busy: 10, idle: 20 },
    model: { providerID: 'provider', id },
    ...extra,
  });
  const calls: unknown[] = [];
  const rows = [
    [
      info('source', 20),
      info('ses_curator_internal', 100, { time: { updated: 100, busy: 100 } }),
      info('hidden', 100),
    ],
    [
      info('foreign', 100, {
        location: { directory: '/another' },
        time: { updated: 100, busy: 100 },
      }),
      info('child', 50, { parentID: 'source', time: { updated: 50, busy: 30 } }),
    ],
  ];
  const sessions = {
    list: async (input: { cursor?: unknown }) => {
      calls.push(input.cursor);
      return {
        data: rows[input.cursor ? 1 : 0]!,
        cursor: input.cursor ? {} : { next: 'next-page' },
      };
    },
  } as unknown as Parameters<typeof readCuratorSessionState>[0];
  const result = await readCuratorSessionState(sessions, directory, (id) => id === 'hidden');
  assert.deepEqual(calls, [undefined, 'next-page']);
  assert.equal(
    result.idle,
    false,
    'a child running outside the first page still blocks maintenance',
  );
  assert.equal(result.last_activity_at, 30);
  assert.deepEqual(result.execution, { provider: 'provider', model: 'source' });
});
