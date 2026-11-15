import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { contextCharLimit, fitsContext } from '../src/context.js';
import { CuratorCore } from '../src/core.js';
import type { Job } from '../src/jobs.js';
import { defaults, settingsSchema, SettingsService } from '../src/settings.js';
import { Store } from '../src/store.js';

const scope = { tenant_id: 'unlimited-tenant', workspace_id: 'unlimited-workspace' };
const pack = (name: string, body = 'Keep the verified procedure.') => ({
  'SKILL.md': `---\nname: ${name}\ndescription: A reusable procedure.\n---\n\n${body}\n`,
});

function storage(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'curator-unlimited-'));
  const path = join(directory, 'state.db');
  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, path, settings: new SettingsService(store) };
}

test('fresh production settings enable automatic publication, semantic review and unlimited cost while retaining the context budget', (t) => {
  const { settings } = storage(t);
  const effective = settings.get(scope).settings;
  assert.deepEqual(effective.limits, {
    daily_cost_usd: null,
    max_job_cost_usd: null,
    max_context_tokens: 45000,
  });
  assert.deepEqual(effective.approval, {
    mode: 'auto',
    allow_auto_create: true,
    allow_auto_merge: true,
    allow_auto_patch_managed_low_risk: true,
    allow_auto_archive_managed: true,
    protect_manual_skills: true,
  });
  assert.equal(effective.curator.llm_review_enabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(effective)), effective);
  assert.equal(settingsSchema.safeParse(effective).success, true);
});

test('finite, zero-cost and unlimited settings remain distinct and retain persisted overrides after restart', (t) => {
  const { store, path, settings } = storage(t);
  settings.patch(
    scope,
    'owner',
    {
      limits: { daily_cost_usd: 0, max_job_cost_usd: 0.25, max_context_tokens: 8000 },
      approval: {
        mode: 'manual',
        allow_auto_create: false,
        allow_auto_merge: false,
        allow_auto_patch_managed_low_risk: false,
        allow_auto_archive_managed: false,
      },
      curator: { llm_review_enabled: false },
    },
    0,
  );
  const before = settings.get(scope).settings;
  store.close();
  const reopened = new Store(path);
  try {
    const service = new SettingsService(reopened);
    assert.deepEqual(service.get(scope).settings, before);
    const result = service.patch(scope, 'owner', { limits: defaults.limits }, 1);
    assert.deepEqual(result.settings.limits, defaults.limits);
    assert.equal(result.settings.approval.mode, 'manual');
    assert.equal(result.settings.curator.llm_review_enabled, false);
  } finally {
    reopened.close();
  }
});

test('disabled cost limits use null while invalid numeric budgets and disabled context remain rejected', () => {
  for (const key of ['daily_cost_usd', 'max_job_cost_usd', 'max_context_tokens'] as const) {
    for (const value of [-1, NaN, Infinity, -Infinity]) {
      const settings = structuredClone(defaults);
      settings.limits[key] = value;
      assert.equal(settingsSchema.safeParse(settings).success, false, `${key}: ${value}`);
    }
  }
  const settings = structuredClone(defaults);
  settings.limits.daily_cost_usd = 0;
  settings.limits.max_job_cost_usd = 0;
  assert.equal(settingsSchema.safeParse(settings).success, true);
  settings.limits.max_context_tokens = 0;
  assert.equal(settingsSchema.safeParse(settings).success, false);
  assert.equal(
    settingsSchema.safeParse({
      ...defaults,
      limits: { ...defaults.limits, max_context_tokens: null },
    }).success,
    false,
  );
});

test('retained context budget checks large requests, serialization and output limits independently of cost limits', () => {
  const settings = structuredClone(defaults);
  const value = { content: 'x'.repeat(200_000) };
  assert.ok(Number.isFinite(contextCharLimit(settings)));
  assert.equal(fitsContext(value, settings), false);
  assert.equal(fitsContext({ content: 'x'.repeat(60000) }, settings), true);
  assert.equal(fitsContext(undefined, settings), false);
  assert.equal(fitsContext({ content: 1n }, settings), false);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(fitsContext(cyclic, settings), false);
  assert.throws(() => contextCharLimit(settings, { max_tokens: 0 }));
  settings.limits.max_context_tokens = 45_000;
  assert.equal(fitsContext(value, settings), false);
  assert.equal(contextCharLimit(settings, { max_tokens: 1000 }), 125_250);
});

test('unlimited optimizer cost retains package context checks and supports a larger finite context without truncation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'curator-unlimited-optimizer-'));
  const core = new CuratorCore({ dataDirectory: directory });
  t.after(async () => {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const body = 'Preserve every instruction in this procedure.\n'.repeat(4000);
  const files = { ...pack('large-procedure', body), 'reference.txt': 'resource bytes\n' };
  const selected = core.catalog.create(scope, 'owner', files);
  const other = core.catalog.create(scope, 'owner', pack('other-procedure'));
  const initial = core.optimizer.prepare(scope, [selected.skill_id]);
  assert.equal(initial.batches.length, 0);
  assert.deepEqual(initial.skipped, [
    { skill_id: selected.skill_id, reason: 'package_exceeds_context_limit' },
  ]);
  core.settings.patch(scope, 'owner', { limits: { max_context_tokens: 200000 } }, 0);
  const plan = core.optimizer.prepare(scope, [selected.skill_id]);
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.skipped, []);
  const timestamp = new Date().toISOString();
  const job: Job = {
    ...scope,
    job_id: randomUUID(),
    operation: 'optimize',
    executor_mode: 'direct',
    status: 'running',
    execution: {},
    payload: plan.batches[0]!,
    requested_by: 'owner',
    idempotency_key: randomUUID(),
    correlation_id: randomUUID(),
    attempt: 1,
    created_at: timestamp,
    updated_at: timestamp,
    progress: 0,
    cost: 0,
    max_cost_usd: null,
    proposal_ids: [],
    source_refs: [],
  };
  const context = core.optimizer.buildPayload(job) as {
    skills: Array<{ files: Record<string, string> }>;
    catalog: Array<{ skill_id: string }>;
    catalog_omitted: number;
  };
  assert.deepEqual(context.skills[0]!.files, files);
  assert.ok(context.catalog.some((entry) => entry.skill_id === other.skill_id));
  assert.equal(context.catalog_omitted, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(context)), context);
});
