import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationReview, type ReviewDrainOptions } from '../src/conversation-review.js';
import { defaults } from '../src/settings.js';
import { Store } from '../src/store.js';
import type { Settings } from '../src/types.js';
import { scope } from './helpers.js';

const start = Date.UTC(2026, 10, 14, 12);
function settings(patch: Partial<Settings['conversation_review']> = {}): Settings {
  return {
    ...structuredClone(defaults),
    conversation_review: {
      enabled: true,
      every_n_actions: 10,
      min_age_sec: 0,
      debounce_sec: 0,
      ...patch,
    },
  };
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'curator-conversation-'));
  const path = join(dir, 'curator.sqlite');
  let store = new Store(path);
  let review = new ConversationReview(store, scope);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const queued: { session: string; key: string }[] = [];
  const options: ReviewDrainOptions = {
    settings: settings(),
    paused: false,
    now: start,
    readState: async () => ({ idle: true }),
    run: async (session, key) => {
      queued.push({ session, key });
      return { job_id: 'job-' + queued.length };
    },
  };
  const activity = (session: string, count = 10, offset = 0) => {
    for (let i = offset; i < offset + count; i++) review.activity(session, 'tool-' + i, start);
  };
  return {
    get store() {
      return store;
    },
    get review() {
      return review;
    },
    queued,
    options,
    activity,
    restart: () => {
      store.close();
      store = new Store(path);
      review = new ConversationReview(store, scope);
    },
  };
}

test('conversation reviews count actions across turns and wait for a successful final response', async (t) => {
  const f = fixture(t);
  f.activity('session', 5);
  f.review.completed('session', 'response-one', start);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 0);
  f.activity('session', 5, 5);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 0, 'an unfinished response cannot trigger review');
  f.review.completed('session', 'response-two', start);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0]?.session, 'session');
  await f.review.drain(f.options);
  f.review.completed('session', 'response-with-no-new-tools', start);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 1, 'completion events alone do not retrigger review');
});

test('a new response or interruption invalidates the old completion boundary', async (t) => {
  const f = fixture(t);
  f.activity('session');
  f.review.completed('session', 'old-success', start);
  f.review.sessionStarted('session', 'new-request', start);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 0);
  f.review.completed('session', 'new-success', start);
  f.review.interrupted('session', 'interrupt', start);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 0);
  f.review.completed('session', 'resumed-success', start);
  await f.review.drain({ ...f.options, readState: async () => ({ idle: false }) });
  assert.equal(f.queued.length, 0, 'the native session must still be idle');
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 1);
});

test('action and completion deduplication survives a storage restart', async (t) => {
  const f = fixture(t);
  f.activity('session');
  f.review.completed('session', 'success', start);
  f.restart();
  f.activity('session');
  f.review.completed('session', 'success', start);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 1);
  f.restart();
  f.activity('session');
  f.review.completed('session', 'success', start);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 1, 'a queued review stays consumed after plugin reload');
  f.activity('session', 9, 10);
  f.review.completed('session', 'not-enough-new-tools', start);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 1, 'duplicates did not accumulate unseen actions');
});

test('independent conversations and tenant scopes never pool their action count', async (t) => {
  const f = fixture(t);
  f.activity('one', 5);
  f.activity('two', 5);
  f.review.completed('one', 'done', start);
  f.review.completed('two', 'done', start);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 0);
  const other = new ConversationReview(f.store, { ...scope, workspace_id: 'other' });
  other.completed('one', 'done', start);
  await other.drain(f.options);
  assert.equal(f.queued.length, 0);
  f.activity('one', 5, 5);
  f.review.completed('one', 'done-new', start);
  await f.review.drain(f.options);
  assert.deepEqual(
    f.queued.map((job) => job.session),
    ['one'],
  );
});

test('internal conversations never count; disabled children, pauses and quiet hours defer review', async (t) => {
  const f = fixture(t);
  f.store.put('control', 'internal:internal', { internal: true });
  f.activity('internal');
  f.review.completed('internal', 'done', start);
  f.activity('ses_curator_older_internal_session');
  f.review.completed('ses_curator_older_internal_session', 'done', start);
  f.activity('child');
  f.review.completed('child', 'done', start);
  const s = settings();
  s.auto_learning.include_child_sessions = false;
  await f.review.drain({
    ...f.options,
    settings: s,
    readState: async () => ({ idle: true, child: true }),
  });
  await f.review.drain({ ...f.options, paused: true });
  await f.review.drain({ ...f.options, settings: settings({ enabled: false }) });
  s.auto_learning.quiet_hours = [12];
  await f.review.drain({ ...f.options, settings: s });
  assert.equal(f.queued.length, 0);
  await f.review.drain(f.options);
  assert.deepEqual(
    f.queued.map((job) => job.session),
    ['child'],
  );
});

test('minimum response age and action debounce both apply', async (t) => {
  const f = fixture(t);
  f.activity('session');
  f.review.completed('session', 'done', start + 5_000);
  const options = { ...f.options, settings: settings({ min_age_sec: 20, debounce_sec: 40 }) };
  await f.review.drain({ ...options, now: start + 24_000 });
  await f.review.drain({ ...options, now: start + 39_999 });
  assert.equal(f.queued.length, 0);
  await f.review.drain({ ...options, now: start + 40_000 });
  assert.equal(f.queued.length, 1);
});

test('retry errors retain the snapshot and idempotency key with durable backoff', async (t) => {
  const f = fixture(t);
  f.activity('session');
  f.review.completed('session', 'done', start);
  const attempts: string[] = [];
  const run = async (_session: string, key: string) => {
    attempts.push(key);
    throw new Error('private context and provider credentials should not enter events');
  };
  await f.review.drain({ ...f.options, run });
  assert.equal(attempts.length, 1);
  f.restart();
  await f.review.drain({ ...f.options, now: start + 29_999, run });
  assert.equal(attempts.length, 1);
  await f.review.drain({ ...f.options, now: start + 30_000, run });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  await f.review.drain({ ...f.options, now: start + 89_999 });
  assert.equal(f.queued.length, 0);
  await f.review.drain({ ...f.options, now: start + 90_000 });
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0]?.key, attempts[0]);
  const events = JSON.stringify(f.store.all('events'));
  assert.ok(!events.includes('private context'));
  assert.ok(events.includes('health.conversation_review_failed'));
});

test('known preacceptance rejection uses a fresh key after budget recovery', async (t) => {
  const f = fixture(t);
  f.activity('session');
  f.review.completed('session', 'done', start);
  const rejectedKeys = new Set<string>();
  const attempts: string[] = [];
  let budgetAvailable = false;
  const run = async (session: string, key: string) => {
    attempts.push(key);
    // Reproduce the RPC's persisted idempotent rejection after the budget recovers.
    if (!budgetAvailable || rejectedKeys.has(key)) {
      rejectedKeys.add(key);
      throw Object.assign(new Error('budget is exhausted'), { code: 'budget_exceeded' });
    }
    return f.options.run(session, key);
  };
  await f.review.drain({ ...f.options, run });
  budgetAvailable = true;
  f.restart();
  await f.review.drain({ ...f.options, now: start + 30_000, run });
  assert.equal(f.queued.length, 1);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0], attempts[1]);
});

test('unknown acceptance outcome retains its key and requests reconciliation', async (t) => {
  const f = fixture(t);
  f.activity('session');
  f.review.completed('session', 'done', start);
  let acceptedKey = '';
  await f.review.drain({
    ...f.options,
    run: async (_session, key) => {
      acceptedKey = key;
      throw Object.assign(new Error('transport lost after submission'), {
        code: 'unknown_outcome',
      });
    },
  });
  f.restart();
  await f.review.drain({ ...f.options, now: start + 30_000 });
  assert.equal(f.queued[0]?.key, acceptedKey);
  const failure = f.store
    .all<{ type: string; details: Record<string, unknown> }>('events')
    .find((event) => event.type === 'health.conversation_review_failed');
  assert.equal(failure?.details.reconciliation_required, true);
  assert.equal(failure?.details.rejected_before_acceptance, false);
});

test('new activity during native state lookup prevents queuing an obsolete response', async (t) => {
  const f = fixture(t);
  f.activity('session');
  f.review.completed('session', 'done', start);
  await f.review.drain({
    ...f.options,
    readState: async () => {
      f.review.activity('session', 'tool-new-response', start);
      return { idle: true };
    },
  });
  assert.equal(f.queued.length, 0);
  f.review.completed('session', 'new-done', start);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 1);
});

test('queuing a snapshot preserves newer actions and concurrent drains cannot duplicate it', async (t) => {
  const f = fixture(t);
  f.activity('session');
  f.review.completed('session', 'done', start);
  await f.review.drain({
    ...f.options,
    run: async (session, key) => {
      f.activity('session', 5, 10);
      f.review.completed('session', 'next-done', start);
      await f.review.drain(f.options);
      return f.options.run(session, key);
    },
  });
  assert.equal(f.queued.length, 1);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 1);
  f.activity('session', 5, 15);
  f.review.completed('session', 'third-done', start);
  await f.review.drain(f.options);
  assert.equal(f.queued.length, 2);
  assert.notEqual(f.queued[0]?.key, f.queued[1]?.key);
});

test('retention and backlog limits prune only coordinator records in this scope', async (t) => {
  const f = fixture(t);
  f.activity('expired');
  f.review.completed('expired', 'done', start);
  f.review.activity('old', 'tool', start + 2 * 86_400_000);
  f.review.activity('new', 'tool', start + 2 * 86_400_000 + 1);
  f.store.put('control', 'other-control', { kind: 'other', value: 'preserve' });
  const other = new ConversationReview(f.store, { ...scope, workspace_id: 'other' });
  other.activity('other-scope', 'tool', start);
  const s = settings();
  s.auto_learning.max_backlog = 1;
  s.auto_learning.retention_days = 1;
  await f.review.drain({
    ...f.options,
    settings: s,
    paused: true,
    now: start + 2 * 86_400_000 + 2,
  });
  const rows = f.store.all<{ kind?: string; session_id?: string }>('control');
  assert.deepEqual(
    rows
      .filter((row) => row.kind === 'conversation-review')
      .map((row) => row.session_id)
      .sort(),
    ['new', 'other-scope'],
  );
  assert.deepEqual(f.store.get('control', 'other-control'), { kind: 'other', value: 'preserve' });
});
