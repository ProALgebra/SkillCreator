import { z } from 'zod';
import type { Settings, Scope } from './types.js';
import { Store } from './store.js';
import { ensure } from './errors.js';
const positive = z.number().int().positive();
const mode = z.enum(['direct', 'session', 'valeria', 'external', 'auto']);
export const settingsSchema = z
  .object({
    enabled: z.boolean(),
    analysis: z
      .object({
        max_calls: z.number().int().min(2).max(256),
        overlap_chars: z.number().int().min(0).max(2048),
      })
      .strict(),
    conversation_review: z
      .object({
        enabled: z.boolean(),
        every_n_actions: positive,
        min_age_sec: z.number().nonnegative(),
        debounce_sec: z.number().nonnegative(),
        provider: z.string().min(1).max(240).optional(),
        model: z.string().min(1).max(240).optional(),
        variant: z.string().min(1).max(240).optional(),
      })
      .strict()
      .refine((v) => Boolean(v.provider) === Boolean(v.model), 'Set provider and model together'),
    auto_learning: z
      .object({
        enabled: z.boolean(),
        on_session_end: z.boolean(),
        every_n_sessions: positive,
        include_child_sessions: z.boolean(),
        backfill_on_first_start: z.literal(false),
        min_age_sec: z.number().nonnegative(),
        debounce_sec: z.number().nonnegative(),
        max_backlog: positive,
        retention_days: positive,
        quiet_hours: z.array(z.number().int().min(0).max(23)),
      })
      .strict(),
    curator: z
      .object({
        enabled: z.boolean(),
        interval_hours: z.number().positive(),
        min_idle_hours: z.number().nonnegative(),
        max_batch_skills: z.number().int().min(2).max(50),
        max_batches_per_run: z.number().int().min(1).max(50),
        provider: z.string().min(1).max(240).optional(),
        model: z.string().min(1).max(240).optional(),
        variant: z.string().min(1).max(240).optional(),
        llm_review_enabled: z.boolean(),
        stale_after_days: positive,
        archive_after_days: positive,
        archive_requires_evidence: z.boolean(),
      })
      .strict()
      .refine((v) => Boolean(v.provider) === Boolean(v.model), 'Set provider and model together'),
    execution: z
      .object({
        default_mode: mode,
        auto_preferred_modes: z
          .array(z.enum(['direct', 'session', 'valeria', 'external']))
          .nonempty(),
        fallback_before_accept_only: z.literal(true),
        max_parallel_total: positive,
        max_parallel_per_workspace: positive,
        max_parallel_per_executor: positive,
        operation_modes: z.record(z.string(), mode),
      })
      .strict(),
    approval: z
      .object({
        mode: z.enum(['manual', 'safe', 'auto']),
        allow_auto_create: z.boolean(),
        allow_auto_merge: z.boolean(),
        allow_auto_patch_managed_low_risk: z.boolean(),
        allow_auto_archive_managed: z.boolean(),
        protect_manual_skills: z.literal(true),
      })
      .strict(),
    limits: z
      .object({
        daily_cost_usd: z.number().nonnegative(),
        max_job_cost_usd: z.number().nonnegative(),
        max_context_tokens: positive,
      })
      .strict(),
    privacy: z
      .object({
        redact_secrets: z.literal(true),
        send_raw_transcripts_to_external: z.boolean(),
        exclude_internal_sessions: z.literal(true),
      })
      .strict(),
    valeria_bridge: z
      .object({ enabled: z.boolean(), worker_kind: z.literal('valeria'), lease_seconds: positive })
      .strict(),
    external_bridge: z.object({ enabled: z.boolean(), lease_seconds: positive }).strict(),
  })
  .strict()
  .refine(
    (s) => s.curator.archive_after_days >= s.curator.stale_after_days,
    'archive_after_days must be >= stale_after_days',
  );
export const defaults: Settings = {
  enabled: true,
  analysis: { max_calls: 64, overlap_chars: 128 },
  conversation_review: {
    enabled: true,
    every_n_actions: 10,
    min_age_sec: 30,
    debounce_sec: 5,
  },
  auto_learning: {
    enabled: true,
    on_session_end: true,
    every_n_sessions: 5,
    include_child_sessions: true,
    backfill_on_first_start: false,
    min_age_sec: 30,
    debounce_sec: 5,
    max_backlog: 1000,
    retention_days: 30,
    quiet_hours: [],
  },
  curator: {
    enabled: true,
    interval_hours: 168,
    min_idle_hours: 2,
    max_batch_skills: 8,
    max_batches_per_run: 8,
    llm_review_enabled: false,
    stale_after_days: 30,
    archive_after_days: 90,
    archive_requires_evidence: true,
  },
  execution: {
    default_mode: 'auto',
    auto_preferred_modes: ['direct', 'session'],
    fallback_before_accept_only: true,
    max_parallel_total: 2,
    max_parallel_per_workspace: 1,
    max_parallel_per_executor: 2,
    operation_modes: {},
  },
  approval: {
    mode: 'manual',
    allow_auto_create: false,
    allow_auto_merge: false,
    allow_auto_patch_managed_low_risk: false,
    allow_auto_archive_managed: false,
    protect_manual_skills: true,
  },
  limits: { daily_cost_usd: 3, max_job_cost_usd: 1, max_context_tokens: 45000 },
  privacy: {
    redact_secrets: true,
    send_raw_transcripts_to_external: false,
    exclude_internal_sessions: true,
  },
  valeria_bridge: { enabled: false, worker_kind: 'valeria', lease_seconds: 120 },
  external_bridge: { enabled: false, lease_seconds: 120 },
};
export function mergeSettings(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    ensure(
      !['__proto__', 'constructor', 'prototype'].includes(key),
      'validation_error',
      'Invalid settings key',
    );
    result[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? mergeSettings(result[key], value)
        : value;
  }
  return result;
}
export class SettingsService {
  constructor(private store: Store) {}
  key(scope: Scope, level: 'workspace' | 'tenant' | 'global' = 'workspace'): string {
    return JSON.stringify(
      level === 'global'
        ? ['global']
        : level === 'tenant'
          ? ['tenant', scope.tenant_id]
          : ['workspace', scope.tenant_id, scope.workspace_id],
    );
  }
  get(
    scope: Scope,
    level: 'workspace' | 'tenant' | 'global' = 'workspace',
  ): { revision: number; settings: Settings; inherited_revisions: Record<string, number> } {
    let settings: unknown = structuredClone(defaults);
    const inherited_revisions: Record<string, number> = {};
    let revision = 0;
    const levels = [
      'global',
      ...(level === 'global' ? [] : ['tenant']),
      ...(level === 'workspace' ? ['workspace'] : []),
    ] as ('global' | 'tenant' | 'workspace')[];
    for (const current of levels) {
      const row = this.store.get<{ revision: number; patch?: unknown; settings?: Settings }>(
        'settings',
        this.key(scope, current),
      );
      settings = mergeSettings(settings, row?.patch ?? row?.settings ?? {});
      inherited_revisions[current] = row?.revision ?? 0;
      if (current === level) revision = row?.revision ?? 0;
    }
    const parsed = settingsSchema.safeParse(settings);
    ensure(parsed.success, 'validation_error', 'Inherited settings violate a safety invariant');
    return { revision, settings: parsed.data, inherited_revisions };
  }
  validate(
    scope: Scope,
    patch: unknown,
    level: 'workspace' | 'tenant' | 'global' = 'workspace',
  ): Settings {
    const r = settingsSchema.safeParse(mergeSettings(this.get(scope, level).settings, patch));
    ensure(
      r.success,
      'validation_error',
      r.success ? '' : r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '),
    );
    return r.data;
  }
  patch(
    scope: Scope,
    actor: string,
    patch: unknown,
    revision: number,
    reset = false,
    level: 'workspace' | 'tenant' | 'global' = 'workspace',
  ) {
    return this.store.transaction(() => {
      const previous = this.get(scope, level);
      ensure(revision === previous.revision, 'revision_conflict', 'Settings revision changed');
      if (!reset) this.validate(scope, patch, level);
      const row = this.store.get<{ patch?: unknown; settings?: Settings }>(
        'settings',
        this.key(scope, level),
      );
      const value = {
        revision: previous.revision + 1,
        patch: reset ? {} : mergeSettings(row?.patch ?? row?.settings ?? {}, patch),
      };
      this.store.put('settings', this.key(scope, level), value);
      const effective = this.get(scope, level);
      this.store.emit(
        'settings.changed',
        scope,
        actor,
        this.key(scope, level),
        { level },
        undefined,
        value.revision,
      );
      return effective;
    });
  }
}
