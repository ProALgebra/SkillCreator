import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCodeConversations } from '../src/opencode-conversations.js';

const directory = '/workspace/conversation-adapter';
const scope = { tenant_id: 'adapter-tenant', workspace_id: 'adapter-workspace' };
const info = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  title: 'A completed conversation',
  location: { directory },
  time: { updated: 100, busy: 80, idle: 90 },
  outcome: 'succeeded',
  ...patch,
});
type Sessions = Parameters<typeof openCodeConversations>[0];
const adapter = (sessions: unknown, internal = (_id: string) => false) =>
  openCodeConversations(sessions as Sessions, directory, scope, internal);
const code = (expected: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === expected;

test('OpenCode history includes archived conversations, filters ownership and internal sessions, and redacts titles', async () => {
  const queries: Array<Record<string, unknown>> = [];
  const live = info('live', { title: 'Contact owner@example.test', time: { updated: 300 } });
  const history = adapter(
    {
      list: async (query: Record<string, unknown>) => {
        queries.push(query);
        return {
          data: query.archived
            ? [info('archived', { time: { updated: 200 } }), live]
            : [
                live,
                info('old', { time: { updated: 100 } }),
                info('foreign', { location: { directory: '/workspace/another-project' } }),
                info('ses_curator_reserved'),
                info('registered-internal'),
                info('metadata-internal', { metadata: { skill_curator_internal: true } }),
              ],
        };
      },
    },
    (id) => id === 'registered-internal',
  );
  const result = await history.list(scope, 2);
  assert.deepEqual(result, [
    { session_id: 'live', title: 'Contact [REDACTED_EMAIL]' },
    { session_id: 'archived', title: 'A completed conversation' },
  ]);
  assert.deepEqual(queries.map((query) => query.archived).sort(), [false, true]);
  assert.ok(queries.every((query) => query.directory === directory));
  assert.ok(queries.every((query) => query.limit === 2 && query.order === 'desc'));
});

test('history rejects another tenant or workspace before consulting the SDK', async () => {
  let calls = 0;
  const history = adapter({
    list: async () => {
      calls++;
      return { data: [] };
    },
    get: async () => {
      calls++;
      return info('session');
    },
  });
  for (const other of [
    { ...scope, tenant_id: 'another-tenant' },
    { ...scope, workspace_id: 'another-workspace' },
  ]) {
    await assert.rejects(history.list(other, 10), code('scope_violation'));
    await assert.rejects(history.read(other, 'session'), code('scope_violation'));
  }
  assert.equal(calls, 0);
});

test('history cannot read foreign or internal conversations even when their identifiers are supplied directly', async () => {
  let contextReads = 0;
  for (const session of [
    info('foreign', { location: { directory: directory + '-other' } }),
    info('ses_curator_reserved'),
    info('internal', { metadata: { skill_curator_internal: true } }),
    info('registered-internal'),
  ]) {
    const history = adapter(
      {
        get: async () => session,
        context: async () => {
          contextReads++;
          return [];
        },
      },
      (id) => id === 'registered-internal',
    );
    await assert.rejects(history.read(scope, session.id), code('scope_violation'));
    await assert.rejects(history.state(session.id), code('scope_violation'));
  }
  assert.equal(contextReads, 0);
});

test('a stable idle snapshot preserves user corrections, tool failures and results and inherits the selected model', async () => {
  const messages = [
    { type: 'user', content: [{ type: 'text', text: 'Use the project fixture instead.' }] },
    {
      type: 'assistant',
      content: [
        {
          type: 'tool',
          id: 'tool-failed',
          name: 'read',
          input: { path: 'missing.json' },
          result: { error: 'ENOENT: fixture was not found' },
        },
        { type: 'text', text: 'The project fixture fixed the failing check.' },
      ],
    },
  ];
  let gets = 0;
  const history = adapter({
    get: async () => {
      gets++;
      return info('session', {
        model: { providerID: 'provider-a', id: 'model-b', variant: 'high' },
      });
    },
    context: async ({ sessionID }: { sessionID: string }) => {
      assert.equal(sessionID, 'session');
      return messages;
    },
  });
  const snapshot = await history.read(scope, 'session');
  assert.equal(gets, 2, 'Native session state must be checked around the context read');
  assert.deepEqual(JSON.parse(snapshot.content), messages);
  assert.deepEqual(snapshot.model, { provider: 'provider-a', model: 'model-b', variant: 'high' });
});

test('busy conversations and snapshots that change during capture are rejected', async () => {
  let contextReads = 0;
  const busy = adapter({
    get: async () => info('session', { time: { updated: 100, busy: 100, idle: 90 } }),
    context: async () => {
      contextReads++;
      return [{ type: 'user', content: [] }];
    },
  });
  await assert.rejects(busy.read(scope, 'session'), code('revision_conflict'));
  assert.equal(contextReads, 0);
  for (const changed of [
    info('session', { time: { updated: 101, busy: 80, idle: 90 } }),
    info('session', { time: { updated: 100, busy: 101, idle: 90 } }),
    info('session', { location: { directory: '/workspace/foreign' } }),
  ]) {
    let gets = 0;
    const racing = adapter({
      get: async () => (++gets === 1 ? info('session') : changed),
      context: async () => [{ type: 'user', content: [] }],
    });
    await assert.rejects(racing.read(scope, 'session'), code('revision_conflict'));
  }
});

test('empty native history is explicit and a snapshot without a model does not invent one', async () => {
  const history = adapter({
    list: async () => ({ data: [] }),
    get: async () => info('session'),
    context: async () => [],
  });
  assert.deepEqual(await history.list(scope, 10), []);
  await assert.rejects(history.read(scope, 'session'), code('validation_error'));
  const modelFree = adapter({
    get: async () => info('session'),
    context: async () => [{ type: 'user', content: [] }],
  });
  assert.equal((await modelFree.read(scope, 'session')).model, undefined);
});

test('automatic review state requires a successful idle response and identifies child sessions', async () => {
  for (const [session, expected] of [
    [info('session'), { idle: true, child: false }],
    [info('child', { parentID: 'parent' }), { idle: true, child: true }],
    [info('interrupted', { outcome: 'interrupted' }), { idle: false, child: false }],
    [info('failed', { outcome: 'failed' }), { idle: false, child: false }],
    [info('busy', { time: { updated: 100, busy: 100, idle: 90 } }), { idle: false, child: false }],
  ] as const) {
    const history = adapter({ get: async () => session });
    assert.deepEqual(await history.state(session.id), expected);
  }
});
