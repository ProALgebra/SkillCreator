import { ensure, CuratorError } from './errors.js';
import { hash } from './security.js';
import { now, sameScope, type Execution, type Scope, type Settings } from './types.js';
import type { Job, JobService } from './jobs.js';
import type { LearningBatchPayload, LearningService } from './learning.js';
import type { Store } from './store.js';

type Skip = LearningBatchPayload['learning_batch']['skipped'][number];
export interface LearningContinuationPlan extends Scope {
  run_id: string;
  payload: LearningBatchPayload;
  batches: LearningBatchPayload[];
  execution: Execution;
  external: boolean;
  budget_total: number | null;
  max_calls: number;
  skipped: Skip[];
}
interface Continuation extends Scope {
  kind: 'learning-continuation';
  id: string;
  run_id: string;
  fingerprint: string;
  actor: string;
  marker: string;
  batches: LearningBatchPayload[];
  execution: Execution;
  external: boolean;
  budget_total: number | null;
  max_calls: number;
  skipped: Skip[];
  next_index: number;
  job_ids: string[];
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  blocked_reason?: string;
  created_at: string;
  updated_at: string;
}

const key = (runID: string) => 'learning-continuation:' + runID;
const scopeOf = (value: Scope): Scope => ({
  tenant_id: value.tenant_id,
  workspace_id: value.workspace_id,
});
const active = new Set(['queued', 'waiting_executor', 'running']);
const safeErrors = new Set([
  'budget_exceeded',
  'executor_unavailable',
  'rate_limited',
  'validation_error',
  'revision_conflict',
  'not_found',
  'scope_violation',
  'forbidden',
]);

/** Serial, resumable verified-record batches sharing one requested cost/call allowance. */
export class LearningContinuationService {
  private advancing = false;

  constructor(
    private store: Store,
    private learning: LearningService,
    private jobs: JobService,
    private settings: (scope: Scope) => Settings,
  ) {}

  private maxCalls(settings: Settings): number {
    // Old in-memory hosts may still supply settings created before this group existed.
    const limit =
      (settings as Settings & { analysis?: { max_calls: number } }).analysis?.max_calls ?? 64;
    ensure(
      Number.isSafeInteger(limit) && limit > 0,
      'validation_error',
      'Invalid analysis call limit',
    );
    return limit;
  }

  plan(
    scope: Scope,
    sessionIds: string[] | undefined,
    external: boolean,
    execution: Execution = {},
    marker: string,
  ): LearningContinuationPlan {
    const currentScope = scopeOf(scope);
    const settings = this.settings(currentScope);
    const budget = execution.max_cost_usd ?? settings.limits.max_job_cost_usd;
    ensure(
      budget === null ||
        (Number.isFinite(budget) &&
          budget >= 0 &&
          (settings.limits.max_job_cost_usd === null ||
            budget <= settings.limits.max_job_cost_usd)),
      'budget_exceeded',
      'Learning run budget exceeds the configured limit',
    );
    const maxCalls = this.maxCalls(settings);
    const mode = this.jobs.resolve(currentScope, 'learning', execution);
    ensure(
      external === (mode === 'external' || mode === 'valeria'),
      'validation_error',
      'Learning privacy mode does not match its executor',
    );
    const first = this.learning.prepare(currentScope, sessionIds, external, execution);
    const batches: LearningBatchPayload[] = [];
    const skipped = new Map<string, Skip>();
    let batch = first;
    for (;;) {
      for (const skip of batch.learning_batch.skipped) skipped.set(skip.record_id, skip);
      if (!batch.session_ids.length) break;
      ensure(
        batches.length < maxCalls,
        'budget_exceeded',
        'Learning sources require more batches than the analysis call limit',
      );
      batches.push(batch);
      if (!batch.learning_batch.deferred_ids.length) break;
      batch = this.learning.prepare(
        currentScope,
        batch.learning_batch.deferred_ids,
        external,
        execution,
      );
    }
    const reserve = Math.min(2, batches.length);
    return {
      tenant_id: scope.tenant_id,
      workspace_id: scope.workspace_id,
      run_id: hash([currentScope, 'learning-continuation', marker]),
      payload: first,
      batches,
      execution: {
        ...execution,
        mode,
        ...(budget === null
          ? {}
          : { max_cost_usd: batches.length ? budget / (batches.length + reserve) : 0 }),
      },
      external,
      budget_total: budget,
      max_calls: maxCalls,
      skipped: [...skipped.values()],
    };
  }

  start(scope: Scope, actor: string, plan: LearningContinuationPlan, marker: string): Job {
    ensure(sameScope(scope, plan), 'scope_violation', 'Learning plan belongs to another scope');
    ensure(
      plan.run_id === hash([scopeOf(scope), 'learning-continuation', marker]),
      'idempotency_conflict',
      'Learning run marker changed',
    );
    ensure(
      plan.batches.length > 0,
      'budget_exceeded',
      'No learning records fit the context budget',
    );
    ensure(
      (plan.budget_total === null ||
        (Number.isFinite(plan.budget_total) && plan.budget_total > 0)) &&
        ((plan.budget_total === null && plan.execution.max_cost_usd === undefined) ||
          (Number.isFinite(plan.execution.max_cost_usd) && plan.execution.max_cost_usd! > 0)),
      'budget_exceeded',
      'Learning execution requires a positive run and per-call budget',
    );
    const fingerprint = hash([actor, plan]);
    return this.store.transaction(() => {
      const previous = this.store.get<Continuation>('control', key(plan.run_id));
      if (previous) {
        ensure(
          sameScope(previous, scope) && previous.fingerprint === fingerprint,
          'idempotency_conflict',
          'Learning run marker was reused for a different plan',
        );
        return this.jobs.get(scope, previous.job_ids[0]!);
      }
      this.learning.materialize(scope, plan.batches[0]!, plan.external, plan.execution);
      const at = now();
      const row: Continuation = {
        tenant_id: scope.tenant_id,
        workspace_id: scope.workspace_id,
        kind: 'learning-continuation',
        id: key(plan.run_id),
        run_id: plan.run_id,
        fingerprint,
        actor,
        marker,
        batches: plan.batches,
        execution: plan.execution,
        external: plan.external,
        budget_total: plan.budget_total,
        max_calls: plan.max_calls,
        skipped: plan.skipped,
        next_index: 0,
        job_ids: [],
        status: 'active',
        created_at: at,
        updated_at: at,
      };
      const job = this.queue(row);
      this.store.put('control', row.id, row);
      this.store.emit('learning.continuation_started', scope, actor, row.run_id, {
        batches: row.batches.length,
        budget_total: row.budget_total,
        max_calls: row.max_calls,
        skipped: row.skipped,
      });
      return job;
    });
  }

  private children(row: Continuation): Job[] {
    return row.job_ids.map((id) => this.jobs.get(row, id));
  }

  private usage(row: Continuation) {
    const children = this.children(row);
    return {
      children,
      cost: children.reduce((sum, child) => sum + child.cost, 0),
      cost_known: children.every((child) => child.cost_known !== false),
      calls: children.reduce((sum, child) => sum + child.attempt, 0),
    };
  }

  private queue(row: Continuation): Job {
    const usage = this.usage(row);
    ensure(usage.calls < row.max_calls, 'budget_exceeded', 'Learning run call limit is exhausted');
    if (row.budget_total !== null) {
      const reservation = row.execution.max_cost_usd ?? 0;
      const retained = this.jobs.reservedCost(row, row.job_ids);
      ensure(
        Number.isFinite(reservation) &&
          reservation > 0 &&
          Number.isFinite(usage.cost) &&
          usage.cost >= 0 &&
          Number.isFinite(retained) &&
          retained >= 0 &&
          usage.cost + retained + reservation <= row.budget_total + 1e-9,
        'budget_exceeded',
        'Learning run budget is exhausted',
      );
    }
    const payload = row.batches[row.next_index];
    ensure(payload, 'validation_error', 'Learning continuation batch is missing');
    const scope = scopeOf(row);
    this.learning.materialize(scope, payload, row.external, row.execution);
    const job = this.jobs.run(
      scope,
      row.actor,
      'learning',
      {
        ...payload,
        learning_run_id: row.run_id,
        learning_batch_index: row.next_index,
        learning_batch_count: row.batches.length,
      },
      row.execution,
      row.marker + ':batch:' + row.next_index,
    );
    row.next_index++;
    row.job_ids.push(job.job_id);
    row.status = 'active';
    delete row.blocked_reason;
    row.updated_at = now();
    return job;
  }

  /** Runs before delivery; direct attempts are counted already, external lease attempts are not. */
  assertCanExecute(job: Job): void {
    if (typeof job.payload.learning_run_id !== 'string') return;
    const row = this.store.get<Continuation>('control', key(job.payload.learning_run_id));
    ensure(row && sameScope(row, job), 'not_found', 'Learning continuation is unavailable');
    ensure(
      row.status !== 'cancelled',
      'executor_unavailable',
      'Learning continuation is cancelled',
    );
    ensure(
      row.job_ids.includes(job.job_id),
      'scope_violation',
      'Job is not part of this learning run',
    );
    const usage = this.usage(row);
    const calls = usage.calls + (job.status === 'running' ? 0 : 1);
    ensure(calls <= row.max_calls, 'budget_exceeded', 'Learning run call limit is exhausted');
    if (row.budget_total === null) return;
    const reservation = job.max_cost_usd === null ? null : Math.max(0, job.max_cost_usd - job.cost);
    const retained = this.jobs.reservedCost(
      row,
      row.job_ids,
      job.status === 'running' ? job.attempt_id : undefined,
    );
    ensure(
      Number.isFinite(job.cost) &&
        job.cost >= 0 &&
        reservation !== null &&
        Number.isFinite(reservation) &&
        reservation > 0 &&
        Number.isFinite(usage.cost) &&
        usage.cost >= 0 &&
        Number.isFinite(retained) &&
        retained >= 0 &&
        usage.cost + retained + reservation <= row.budget_total + 1e-9,
      'budget_exceeded',
      'Learning run budget is exhausted',
    );
  }

  advance(): number {
    if (this.advancing) return 0;
    this.advancing = true;
    let queued = 0;
    try {
      const rows = this.store
        .all<Continuation>('control')
        .filter((row) => row.kind === 'learning-continuation');
      for (const snapshot of rows) {
        try {
          queued += this.store.transaction(() => {
            const row = this.store.get<Continuation>('control', snapshot.id)!;
            if (row.status === 'cancelled' || row.status === 'completed') return 0;
            const children = this.children(row);
            const child = children.at(-1)!;
            if (child.status !== 'completed') {
              if (child.status === 'cancelled') {
                row.status = 'cancelled';
                row.blocked_reason = 'child_cancelled';
              } else if (active.has(child.status)) {
                row.status = 'active';
                delete row.blocked_reason;
              } else {
                row.status = 'paused';
                row.blocked_reason = child.status;
              }
              row.updated_at = now();
              this.store.put('control', row.id, row);
              return 0;
            }
            if (row.next_index >= row.batches.length) {
              row.status = 'completed';
              delete row.blocked_reason;
              row.updated_at = now();
              this.store.put('control', row.id, row);
              this.store.emit('learning.continuation_completed', row, row.actor, row.run_id, {
                batches: row.batches.length,
                job_ids: row.job_ids,
              });
              return 0;
            }
            const pause = this.store.get<{ all?: boolean; learning?: boolean }>(
              'control',
              'pause:' + hash({ tenant_id: row.tenant_id, workspace_id: row.workspace_id }),
            );
            ensure(
              this.settings(row).enabled && !pause?.all && !pause?.learning,
              'executor_unavailable',
              'Learning continuation is paused',
            );
            this.queue(row);
            this.store.put('control', row.id, row);
            return 1;
          });
        } catch (error) {
          const row = this.store.get<Continuation>('control', snapshot.id);
          if (!row || row.status === 'cancelled' || row.status === 'completed') continue;
          row.status = 'paused';
          row.blocked_reason =
            error instanceof CuratorError && safeErrors.has(error.code)
              ? error.code
              : 'internal_error';
          row.updated_at = now();
          this.store.put('control', row.id, row);
        }
      }
    } finally {
      this.advancing = false;
    }
    return queued;
  }

  status(job: Job) {
    if (typeof job.payload.learning_run_id !== 'string') return null;
    const row = this.store.get<Continuation>('control', key(job.payload.learning_run_id));
    if (!row || !sameScope(row, job)) return null;
    const usage = this.usage(row);
    const complete = usage.children.filter((child) => child.status === 'completed');
    return {
      run_id: row.run_id,
      status: row.status,
      ...(row.blocked_reason ? { blocked_reason: row.blocked_reason } : {}),
      batches_total: row.batches.length,
      batches_completed: complete.length,
      records_total: row.batches.reduce((sum, batch) => sum + batch.session_ids.length, 0),
      records_processed: complete.reduce(
        (sum, child) => sum + (child.payload.session_ids as string[]).length,
        0,
      ),
      cost_usd: usage.cost,
      cost_known: usage.cost_known,
      budget_total: row.budget_total,
      calls_used: usage.calls,
      max_calls: row.max_calls,
      job_ids: [...row.job_ids],
      proposal_ids: [...new Set(usage.children.flatMap((child) => child.proposal_ids))],
      skipped: row.skipped,
    };
  }

  cancel(scope: Scope, jobOrRunID: string) {
    const job = this.store.get<Job>('jobs', jobOrRunID);
    const runID = job && sameScope(job, scope) ? job.payload.learning_run_id : jobOrRunID;
    ensure(typeof runID === 'string', 'not_found', 'Learning continuation is unavailable');
    const row = this.store.get<Continuation>('control', key(runID));
    ensure(row && sameScope(row, scope), 'not_found', 'Learning continuation is unavailable');
    return this.store.transaction(() => {
      if (row.status !== 'completed') {
        row.status = 'cancelled';
        row.blocked_reason = 'cancelled';
        row.updated_at = now();
        this.store.put('control', row.id, row);
        const child = this.jobs.get(row, row.job_ids.at(-1)!);
        if (child.status !== 'completed' && child.status !== 'cancelled')
          this.jobs.cancel(row, child.job_id);
      }
      return this.status(this.jobs.get(row, row.job_ids[0]!));
    });
  }
}
