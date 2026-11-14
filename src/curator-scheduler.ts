import { hash } from './security.js';
import { Store } from './store.js';
import { sameScope, type Execution, type Scope, type Settings } from './types.js';
import type { Job } from './jobs.js';

interface ScheduleState extends Scope {
  kind: 'curator-schedule';
  id: string;
  initialized_at: number;
  last_run_at: number;
  last_activity_at: number;
  last_observed_at: number;
  activity_version: number;
  sequence: number;
  seen: string[];
  job_ids: string[];
  run_id?: string;
  retry_at: number;
  failures: number;
  last_error?: { code: string; at: number; reconciliation_required: boolean };
  pending?: {
    key: string;
    stage: 'lifecycle' | 'optimize';
    generation: number;
    execution?: Execution;
  };
}

export interface CuratorDrainOptions {
  settings: Settings;
  paused: boolean;
  now?: number;
  readState: () => Promise<{
    idle: boolean;
    last_activity_at?: number;
    execution?: Execution;
  }>;
  lifecycle: (idempotencyKey: string) => Promise<unknown>;
  optimize: (
    idempotencyKey: string,
    execution?: Execution,
  ) => Promise<{ run_id: string; jobs: Array<{ job_id: string }> }>;
}

const keyFor = (scope: Scope) => 'curator-schedule:' + hash(scope);
const activeStatuses = new Set(['queued', 'waiting_executor', 'running', 'unknown_outcome']);
const rejectionCodes = new Set([
  'budget_exceeded',
  'executor_unavailable',
  'rate_limited',
  'validation_error',
  'revision_conflict',
  'not_found',
  'scope_violation',
]);

function initial(scope: Scope, at: number): ScheduleState {
  return {
    ...scope,
    kind: 'curator-schedule',
    id: keyFor(scope),
    initialized_at: at,
    last_run_at: at,
    last_activity_at: at,
    last_observed_at: at,
    activity_version: 0,
    sequence: 0,
    seen: [],
    job_ids: [],
    retry_at: 0,
    failures: 0,
  };
}

function nextRun(state: ScheduleState, settings: Settings): number {
  return Math.max(
    state.pending ? 0 : state.last_run_at + settings.curator.interval_hours * 3_600_000,
    state.last_activity_at + settings.curator.min_idle_hours * 3_600_000,
    state.retry_at,
  );
}

/** Safe to expose over authenticated RPC: neither model responses nor session contents are stored. */
export function curatorScheduleStatus(
  store: Store,
  scope: Scope,
  settings: Settings,
  at = Date.now(),
) {
  const state = store.get<ScheduleState>('control', keyFor(scope)) ?? initial(scope, at);
  return {
    initialized_at: state.initialized_at,
    last_run_at: state.last_run_at,
    last_activity_at: state.last_activity_at,
    last_observed_at: state.last_observed_at,
    next_run_at: nextRun(state, settings),
    job_ids: state.job_ids,
    ...(state.run_id ? { run_id: state.run_id } : {}),
    retry_at: state.retry_at,
    ...(state.last_error ? { last_error: state.last_error } : {}),
    enabled: settings.enabled && settings.curator.enabled,
    llm_review_enabled: settings.curator.llm_review_enabled,
    pending: Boolean(state.pending),
  };
}

/** Persistent schedule, independent of the plugin's process lifetime and timer cadence. */
export class CuratorScheduler {
  private draining = false;

  constructor(
    private store: Store,
    private scope: Scope,
    at = Date.now(),
  ) {
    if (!store.get('control', keyFor(scope)))
      store.put('control', keyFor(scope), initial(scope, at));
  }

  private get(): ScheduleState {
    return this.store.get<ScheduleState>('control', keyFor(this.scope))!;
  }

  private internal(sessionID: string): boolean {
    return (
      sessionID.startsWith('ses_curator_') || !!this.store.get('control', 'internal:' + sessionID)
    );
  }

  activity(sessionID: string, eventID?: string, at = Date.now()): void {
    if (this.internal(sessionID)) return;
    const row = this.get();
    if (eventID) {
      const marker = hash([sessionID, eventID]);
      if (row.seen.includes(marker)) return;
      row.seen = [...row.seen.slice(-511), marker];
    }
    row.activity_version++;
    row.last_activity_at = Math.max(row.last_activity_at, at);
    row.last_observed_at = Math.max(row.last_observed_at, at);
    this.store.put('control', row.id, row);
  }

  private active(): boolean {
    return this.store
      .all<Job>('jobs')
      .some(
        (job) =>
          sameScope(job, this.scope) &&
          (job.operation === 'optimize' || job.payload.optimizer === true) &&
          activeStatuses.has(job.status),
      );
  }

  async drain(options: CuratorDrainOptions): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const at = options.now ?? Date.now();
      const { settings } = options;
      let row = this.get();
      if (
        options.paused ||
        !settings.enabled ||
        !settings.curator.enabled ||
        at < nextRun(row, settings) ||
        this.active()
      )
        return;
      try {
        const native = await options.readState();
        const current = this.get();
        current.last_observed_at = Math.max(current.last_observed_at, at);
        // This also catches activity missed while the plugin was unloaded or the event stream reconnected.
        if (
          native.last_activity_at !== undefined &&
          Number.isFinite(native.last_activity_at) &&
          native.last_activity_at > current.last_activity_at
        ) {
          current.last_activity_at = native.last_activity_at;
          current.activity_version++;
        }
        this.store.put('control', current.id, current);
        if (
          !native.idle ||
          row.activity_version !== current.activity_version ||
          at < nextRun(current, settings) ||
          this.active()
        )
          return;
        row = current;
        if (!row.pending) {
          row.sequence++;
          const configured = settings.curator;
          row.pending = {
            key: 'curator-cycle:' + hash([this.scope, row.sequence, row.last_run_at]),
            stage: 'lifecycle',
            generation: 0,
            execution:
              configured.provider && configured.model
                ? {
                    provider: configured.provider,
                    model: configured.model,
                    ...(configured.variant ? { variant: configured.variant } : {}),
                  }
                : native.execution,
          };
          this.store.put('control', row.id, row);
        }
        const activityVersion = row.activity_version;
        if (row.pending.stage === 'lifecycle') {
          await options.lifecycle(row.pending.key + ':lifecycle:' + row.pending.generation);
          // Keep activity received while the local lifecycle mutation was being serialized.
          row = this.get();
          row.pending!.stage = 'optimize';
          row.pending!.generation = 0;
          this.store.put('control', row.id, row);
        }
        if (row.activity_version !== activityVersion || at < nextRun(row, settings)) return;
        let result: { run_id: string; jobs: Array<{ job_id: string }> } | undefined;
        if (settings.curator.llm_review_enabled) {
          result = await options.optimize(
            row.pending!.key + ':optimize:' + row.pending!.generation,
            row.pending!.execution,
          );
        }
        row = this.get();
        row.last_run_at = at;
        row.retry_at = 0;
        row.failures = 0;
        row.job_ids = result?.jobs.map((job) => job.job_id) ?? [];
        if (result) row.run_id = result.run_id;
        else delete row.run_id;
        delete row.pending;
        delete row.last_error;
        this.store.transaction(() => {
          this.store.put('control', row.id, row);
          this.store.emit('curator.scheduled', this.scope, 'system', row.run_id ?? row.id, {
            job_ids: row.job_ids,
            llm_review_enabled: settings.curator.llm_review_enabled,
            next_run_at: nextRun(row, settings),
          });
        });
      } catch (error) {
        row = this.get();
        const code =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'internal_error';
        // Store only stable error categories. Provider messages can contain credentials or library contents.
        const safeCode =
          rejectionCodes.has(code) || code === 'unknown_outcome' ? code : 'internal_error';
        const rejected = rejectionCodes.has(code);
        if (row.pending && rejected) row.pending.generation++;
        row.failures++;
        row.retry_at = at + Math.min(3_600_000, 30_000 * 2 ** Math.min(row.failures - 1, 7));
        row.last_error = {
          code: safeCode,
          at,
          reconciliation_required: code === 'unknown_outcome',
        };
        this.store.transaction(() => {
          this.store.put('control', row.id, row);
          this.store.emit('health.curator_schedule_failed', this.scope, 'system', row.id, {
            ...row.last_error,
            retry_at: row.retry_at,
            rejected_before_acceptance: rejected,
          });
        });
      }
    } finally {
      this.draining = false;
    }
  }
}
