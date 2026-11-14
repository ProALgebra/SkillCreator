import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { ensure, CuratorError } from './errors.js';
import { hash } from './security.js';
import { redact } from './learning.js';
import { now, sameScope } from './types.js';
import type { Scope, Settings, Execution, Mode } from './types.js';
export type JobStatus =
  | 'queued'
  | 'waiting_executor'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown_outcome';
export interface Job extends Scope {
  job_id: string;
  operation: string;
  executor_mode: Exclude<Mode, 'auto'>;
  status: JobStatus;
  execution: Execution;
  payload: Record<string, unknown>;
  requested_by: string;
  idempotency_key: string;
  correlation_id: string;
  attempt: number;
  created_at: string;
  updated_at: string;
  progress: number;
  cost: number;
  max_cost_usd: number;
  proposal_ids: string[];
  source_refs: string[];
  error?: { code: string; message: string };
  attempt_id?: string;
  cancel_requested?: boolean;
}
interface Attempt extends Scope {
  id: string;
  job_id: string;
  status: string;
  started_at: string;
  ended_at?: string;
  cost: number;
  reserved: number;
  day: string;
}
interface Lease extends Scope {
  job_id: string;
  attempt_id: string;
  worker_kind: 'valeria' | 'external';
  worker_id: string;
  token_hash: string;
  expires_at: string;
  deadline: string;
}
export type Executor = (input: {
  job: Job;
  signal: AbortSignal;
}) => Promise<{ output: unknown; cost_usd?: number }>;

/** An executor explicitly confirms that validation failed before any provider work began. */
export class ExecutorPreflightError extends CuratorError {
  constructor(error: CuratorError) {
    super(error.code, redact(error.message));
    this.name = 'ExecutorPreflightError';
  }
}

function providerRejection(error: unknown): Job['error'] | undefined {
  if (!error || typeof error !== 'object') return;
  const value = error as Record<string, unknown>;
  // PluginHost exposes Generate's internal tag; HTTP clients receive its mapped public tag.
  if (
    (value._tag !== 'ProviderRequestError' && value._tag !== 'Generate.ProviderRequestError') ||
    typeof value.message !== 'string'
  )
    return;
  // Require a provider refusal and its matching HTTP status before releasing an unknown cost.
  if (value.reason === 'rate_limit' && value.status === 429)
    return { code: 'rate_limited', message: redact(value.message) };
  if (
    (value.reason === 'authentication' && [401, 403].includes(value.status as number)) ||
    (value.reason === 'invalid_request' && [400, 422].includes(value.status as number))
  )
    return { code: 'executor_unavailable', message: redact(value.message) };
}

export class JobService {
  private active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private stopped = false;
  constructor(
    private store: Store,
    private settings: (scope: Scope) => Settings,
    private onResult: (job: Job, result: unknown) => string[] | Promise<string[]>,
    private executors: Partial<Record<'direct' | 'session', Executor>> = {},
  ) {
    this.recover();
  }
  list(scope: Scope): Job[] {
    return this.store.all<Job>('jobs').filter((j) => sameScope(j, scope));
  }
  get(scope: Scope, id: string): Job {
    const j = this.store.get<Job>('jobs', id);
    ensure(j && sameScope(j, scope), 'not_found', 'Job not found');
    return j;
  }
  available(scope: Scope) {
    const s = this.settings(scope);
    return {
      direct: !!this.executors.direct,
      session: !!this.executors.session,
      valeria: s.valeria_bridge.enabled,
      external: s.external_bridge.enabled,
    };
  }
  resolve(scope: Scope, operation: string, execution: Execution = {}): Exclude<Mode, 'auto'> {
    const s = this.settings(scope);
    const requested =
      execution.mode ?? s.execution.operation_modes[operation] ?? s.execution.default_mode;
    const available = this.available(scope);
    const selected =
      requested === 'auto' ? s.execution.auto_preferred_modes.find((m) => available[m]) : requested;
    ensure(
      selected && available[selected],
      'executor_unavailable',
      'Requested executor is unavailable',
    );
    return selected;
  }
  remainingBudget(scope: Scope, excludeJobID?: string): number {
    const s = this.settings(scope);
    const today = now().slice(0, 10);
    const used = this.store
      .all<Attempt>('job_attempts')
      .filter((a) => a.tenant_id === scope.tenant_id && a.day === today)
      .reduce((sum, a) => sum + a.cost + a.reserved, 0);
    const queued = this.store
      .all<Job>('jobs')
      .filter(
        (j) =>
          j.tenant_id === scope.tenant_id &&
          j.job_id !== excludeJobID &&
          ['queued', 'waiting_executor'].includes(j.status),
      )
      .reduce((sum, j) => sum + Math.max(0, j.max_cost_usd - j.cost), 0);
    return s.limits.daily_cost_usd - used - queued;
  }
  private budget(scope: Scope, cap: number, excludeJobID?: string) {
    ensure(
      cap <= this.remainingBudget(scope, excludeJobID) + 1e-9,
      'budget_exceeded',
      'Daily tenant budget is exhausted',
    );
  }
  run(
    scope: Scope,
    actor: string,
    operation: string,
    payload: Record<string, unknown>,
    execution: Execution = {},
    marker: string,
  ): Job {
    const s = this.settings(scope);
    ensure(s.enabled && !this.stopped, 'executor_unavailable', 'Background work is paused');
    const mode = this.resolve(scope, operation, execution);
    const cap = execution.max_cost_usd ?? s.limits.max_job_cost_usd;
    ensure(
      Number.isFinite(cap) && cap >= 0 && cap <= s.limits.max_job_cost_usd,
      'budget_exceeded',
      'Job budget exceeds the configured limit',
    );
    ensure(
      !execution.max_tokens || execution.max_tokens <= s.limits.max_context_tokens,
      'budget_exceeded',
      'Context limit exceeded',
    );
    const duplicate = this.list(scope).find((j) => j.idempotency_key === marker);
    if (duplicate) {
      ensure(
        hash([duplicate.operation, duplicate.payload, duplicate.execution]) ===
          hash([operation, payload, { ...execution, mode: duplicate.executor_mode }]),
        'idempotency_conflict',
        'Job marker reused',
      );
      return duplicate;
    }
    const j: Job = {
      ...scope,
      job_id: randomUUID(),
      operation,
      executor_mode: mode,
      status: mode === 'external' || mode === 'valeria' ? 'waiting_executor' : 'queued',
      execution: { ...execution, mode },
      payload,
      requested_by: actor,
      idempotency_key: marker,
      correlation_id: randomUUID(),
      attempt: 0,
      created_at: now(),
      updated_at: now(),
      progress: 0,
      cost: 0,
      max_cost_usd: cap,
      proposal_ids: [],
      source_refs: Array.isArray(payload.source_refs) ? (payload.source_refs as string[]) : [],
    };
    this.store.transaction(() => {
      this.budget(scope, cap);
      this.store.put('jobs', j.job_id, j);
      this.store.emit(
        'job.created',
        scope,
        actor,
        j.job_id,
        { executor_mode: mode },
        j.correlation_id,
      );
      if (j.status === 'waiting_executor')
        this.store.emit(
          'job.waiting_executor',
          scope,
          actor,
          j.job_id,
          { executor_mode: mode },
          j.correlation_id,
        );
    });
    return j;
  }
  private save(j: Job): Job {
    j.updated_at = now();
    this.store.put('jobs', j.job_id, j);
    return j;
  }
  private order(jobs: Job[]): Job[] {
    const priority = { high: 2, normal: 1, low: 0 };
    return jobs.sort(
      (a, b) =>
        priority[b.execution.priority ?? 'normal'] - priority[a.execution.priority ?? 'normal'] ||
        a.created_at.localeCompare(b.created_at),
    );
  }
  private capacity(j: Job): boolean {
    const s = this.settings(j);
    const running = this.store
      .all<Job>('jobs')
      .filter((a) => a.status === 'running' || a.status === 'unknown_outcome');
    return (
      running.length < s.execution.max_parallel_total &&
      running.filter((a) => sameScope(a, j)).length < s.execution.max_parallel_per_workspace &&
      running.filter((a) => a.executor_mode === j.executor_mode).length <
        Math.min(s.execution.max_parallel_per_executor, j.execution.max_parallel ?? Infinity)
    );
  }
  private begin(j: Job): void {
    ensure(this.capacity(j), 'rate_limited', 'Concurrency limit reached');
    const s = this.settings(j);
    ensure(s.enabled && !this.stopped, 'executor_unavailable', 'Background work is paused');
    this.budget(j, j.max_cost_usd - j.cost, j.job_id);
    j.attempt++;
    j.attempt_id = randomUUID();
    j.status = 'running';
    this.store.put('job_attempts', j.attempt_id, {
      ...{ tenant_id: j.tenant_id, workspace_id: j.workspace_id },
      id: j.attempt_id,
      job_id: j.job_id,
      status: 'running',
      started_at: now(),
      cost: 0,
      reserved: j.max_cost_usd - j.cost,
      day: now().slice(0, 10),
    } satisfies Attempt);
    this.save(j);
    this.store.emit(
      'job.started',
      j,
      j.requested_by,
      j.job_id,
      { attempt: j.attempt, executor_mode: j.executor_mode },
      j.correlation_id,
    );
  }
  private settle(j: Job, cost: number, known: boolean): void {
    if (!j.attempt_id) return;
    const a = this.store.get<Attempt>('job_attempts', j.attempt_id)!;
    a.status = j.status;
    if (known) {
      a.cost = cost;
      a.reserved = 0;
      a.ended_at = now();
    }
    this.store.put('job_attempts', a.id, a);
    j.cost = this.store
      .all<Attempt>('job_attempts')
      .filter((a) => a.job_id === j.job_id)
      .reduce((s, a) => s + a.cost, 0);
  }
  private unknown(j: Job, reason: string): void {
    j.status = 'unknown_outcome';
    j.error = { code: 'unknown_outcome', message: reason };
    this.settle(j, 0, false);
    this.save(j);
    this.store.emit(
      'job.failed',
      j,
      j.requested_by,
      j.job_id,
      { code: 'unknown_outcome' },
      j.correlation_id,
    );
  }
  recover(): void {
    this.store.transaction(() => {
      for (const j of this.store.all<Job>('jobs'))
        if (
          j.status === 'running' &&
          (j.executor_mode === 'direct' || j.executor_mode === 'session')
        )
          this.unknown(j, 'Process stopped during execution; reconcile before any new run');
    });
    this.expire();
  }
  expire(): void {
    for (const lease of this.store.all<Lease>('job_leases'))
      if (Date.parse(lease.expires_at) <= Date.now()) {
        const j = this.store.get<Job>('jobs', lease.job_id);
        if (j && j.status === 'running')
          this.unknown(j, 'Worker lease expired; reconcile the durable marker');
      }
  }
  pause(scope: Scope, id: string): Job {
    const j = this.get(scope, id);
    ensure(
      ['queued', 'waiting_executor'].includes(j.status),
      'unknown_outcome',
      'Running jobs require cancellation and reconciliation',
    );
    j.status = 'interrupted';
    return this.save(j);
  }
  resume(scope: Scope, id: string): Job {
    const j = this.get(scope, id);
    ensure(j.status === 'interrupted', 'validation_error', 'Job is not paused');
    this.budget(j, j.max_cost_usd - j.cost, j.job_id);
    j.status = ['valeria', 'external'].includes(j.executor_mode) ? 'waiting_executor' : 'queued';
    return this.save(j);
  }
  cancel(scope: Scope, id: string): Job {
    const j = this.get(scope, id);
    ensure(!['completed', 'cancelled'].includes(j.status), 'validation_error', 'Job already ended');
    if (j.status === 'running' || j.status === 'unknown_outcome') {
      j.cancel_requested = true;
      this.unknown(j, 'Cancellation requested after acceptance; wait for executor acknowledgement');
      this.active.get(id)?.abort.abort();
    } else {
      j.status = 'cancelled';
      this.save(j);
      this.store.emit('job.cancelled', scope, j.requested_by, id);
    }
    return j;
  }
  retry(scope: Scope, id: string): Job {
    const j = this.get(scope, id);
    ensure(j.status === 'failed', 'unknown_outcome', 'Only a definitely failed job can be retried');
    ensure(!this.active.has(id), 'rate_limited', 'Executor is still stopping');
    ensure(j.cost < j.max_cost_usd, 'budget_exceeded', 'No budget remains');
    this.budget(j, j.max_cost_usd - j.cost, j.job_id);
    j.status = ['valeria', 'external'].includes(j.executor_mode) ? 'waiting_executor' : 'queued';
    delete j.error;
    this.store.delete('control', 'receipt:' + id);
    return this.save(j);
  }
  reconcileCancellation(
    scope: Scope,
    id: string,
    actor: string,
    cost: number,
    reason: string,
  ): Job {
    const j = this.get(scope, id);
    ensure(
      j.status === 'unknown_outcome',
      'validation_error',
      'Only an unknown outcome needs reconciliation',
    );
    ensure(
      Number.isFinite(cost) && cost >= 0,
      'validation_error',
      'A known nonnegative cost is required',
    );
    j.status = 'cancelled';
    j.cancel_requested = true;
    this.active.get(id)?.abort.abort();
    return this.store.transaction(() => {
      this.settle(j, cost, true);
      this.store.delete('job_leases', id);
      this.save(j);
      this.store.emit('job.cancelled', scope, actor, id, {
        reconciled: true,
        reason: redact(reason),
        cost_usd: cost,
      });
      return j;
    });
  }
  lease(
    scope: Scope,
    kind: 'valeria' | 'external',
    worker: string,
  ): { job: Job; lease_token: string; expires_at: string } | null {
    this.expire();
    ensure(this.available(scope)[kind], 'executor_unavailable', 'Worker bridge is disabled');
    return this.store.transaction(() => {
      const j = this.order(this.list(scope)).find(
        (j) => j.executor_mode === kind && j.status === 'waiting_executor' && this.capacity(j),
      );
      if (!j) return null;
      this.begin(j);
      const token = randomBytes(32).toString('base64url');
      const s = this.settings(scope);
      const ttl =
        kind === 'valeria' ? s.valeria_bridge.lease_seconds : s.external_bridge.lease_seconds;
      const deadline = new Date(Date.now() + (j.execution.timeout_sec ?? 300) * 1000).toISOString();
      const expires_at = new Date(
        Math.min(Date.now() + ttl * 1000, Date.parse(deadline)),
      ).toISOString();
      const lease: Lease = {
        ...scope,
        job_id: j.job_id,
        attempt_id: j.attempt_id!,
        worker_kind: kind,
        worker_id: worker,
        token_hash: hash(token),
        expires_at,
        deadline,
      };
      this.store.put('job_leases', j.job_id, lease);
      return { job: j, lease_token: token, expires_at };
    });
  }
  private authorizeLease(
    scope: Scope,
    id: string,
    worker: string,
    token: string,
    reconcile = false,
  ): { job: Job; lease: Lease } {
    const job = this.get(scope, id);
    const lease = this.store.get<Lease>('job_leases', id);
    const actual = Buffer.from(hash(token));
    const expected = Buffer.from(lease?.token_hash ?? '');
    ensure(
      lease &&
        lease.worker_id === worker &&
        actual.length === expected.length &&
        timingSafeEqual(actual, expected),
      'forbidden',
      'Invalid lease capability',
    );
    if (Date.parse(lease.expires_at) <= Date.now() || Date.parse(lease.deadline) <= Date.now()) {
      if (job.status === 'running') this.unknown(job, 'Worker lease expired');
      if (!reconcile) throw new CuratorError('lease_expired', 'Lease expired');
    }
    return { job: this.get(scope, id), lease };
  }
  heartbeat(scope: Scope, id: string, worker: string, token: string, progress = 0): Job {
    const { job: j, lease } = this.authorizeLease(scope, id, worker, token);
    ensure(j.status === 'running', 'unknown_outcome', 'Job is not running');
    const s = this.settings(scope);
    const ttl =
      lease.worker_kind === 'valeria'
        ? s.valeria_bridge.lease_seconds
        : s.external_bridge.lease_seconds;
    lease.expires_at = new Date(
      Math.min(Date.now() + ttl * 1000, Date.parse(lease.deadline)),
    ).toISOString();
    j.progress = progress;
    this.store.transaction(() => {
      this.store.put('job_leases', id, lease);
      this.save(j);
      this.store.emit('job.progress', scope, worker, id, { progress });
    });
    return j;
  }
  async complete(
    scope: Scope,
    id: string,
    worker: string,
    token: string,
    result: { output: unknown; cost_usd?: number },
  ): Promise<Job> {
    const previous = this.store.get<{ worker: string; token_hash: string; result_hash: string }>(
      'control',
      'receipt:' + id,
    );
    if (previous) {
      ensure(
        previous.worker === worker && previous.token_hash === hash(token),
        'forbidden',
        'Invalid completion capability',
      );
      ensure(
        previous.result_hash === hash(result),
        'idempotency_conflict',
        'Worker completion payload changed',
      );
      return this.get(scope, id);
    }
    const { job, lease } = this.authorizeLease(scope, id, worker, token, true);
    ensure(
      job.status === 'running' || job.status === 'unknown_outcome',
      'validation_error',
      'Job already ended',
    );
    const completed = await this.finish(job, result);
    this.store.put('control', 'receipt:' + id, {
      worker,
      token_hash: lease.token_hash,
      result_hash: hash(result),
    });
    return completed;
  }
  fail(scope: Scope, id: string, worker: string, token: string, error: string, cost = 0): Job {
    const { job: j } = this.authorizeLease(scope, id, worker, token);
    ensure(
      j.status === 'running' || j.status === 'unknown_outcome',
      'validation_error',
      'Job already ended',
    );
    ensure(Number.isFinite(cost) && cost >= 0, 'validation_error', 'Invalid cost');
    j.status = 'failed';
    j.error = { code: 'internal_error', message: redact(error) };
    this.store.transaction(() => {
      this.settle(j, cost, true);
      this.save(j);
      this.store.delete('job_leases', id);
      this.store.emit('job.failed', scope, worker, id);
    });
    return j;
  }
  private async finish(j: Job, result: { output: unknown; cost_usd?: number }): Promise<Job> {
    const cost = result.cost_usd;
    ensure(
      cost !== undefined && Number.isFinite(cost) && cost >= 0,
      'validation_error',
      'Executor must report a nonnegative cost',
    );
    const latest = this.get(j, j.job_id);
    if (latest.status === 'unknown_outcome' && latest.cancel_requested) {
      latest.status = 'cancelled';
      this.store.transaction(() => {
        this.settle(latest, cost, true);
        this.save(latest);
        this.store.delete('job_leases', latest.job_id);
        this.store.emit('job.cancelled', latest, latest.requested_by, latest.job_id);
      });
      return latest;
    }
    if (latest.status === 'unknown_outcome') {
      latest.status = 'running';
      delete latest.error;
      this.save(latest);
      j = latest;
    }
    if (j.cost + cost > j.max_cost_usd) {
      j.status = 'failed';
      j.error = { code: 'budget_exceeded', message: 'Reported job cost exceeds its budget' };
      this.store.transaction(() => {
        this.settle(j, cost, true);
        this.save(j);
        this.store.delete('job_leases', j.job_id);
        this.store.emit('job.failed', j, j.requested_by, j.job_id, { code: 'budget_exceeded' });
      });
      return j;
    }
    try {
      // onResult only writes declarative candidates/proposals and is synchronous in the core.
      const ids = await this.onResult(j, result.output);
      j.proposal_ids = ids;
      j.status = 'completed';
      j.progress = 1;
      this.store.transaction(() => {
        this.settle(j, cost, true);
        this.save(j);
        this.store.delete('job_leases', j.job_id);
        this.store.emit(
          'job.completed',
          j,
          j.requested_by,
          j.job_id,
          { proposal_ids: ids, cost },
          j.correlation_id,
        );
      });
    } catch (error) {
      j.status = 'failed';
      j.error = {
        code: error instanceof CuratorError ? error.code : 'validation_error',
        message: error instanceof CuratorError ? error.message : 'Invalid executor result',
      };
      this.store.transaction(() => {
        this.settle(j, cost, true);
        this.save(j);
        this.store.delete('job_leases', j.job_id);
        this.store.emit('job.failed', j, j.requested_by, j.job_id, { code: j.error!.code });
      });
    }
    return j;
  }
  async drain(): Promise<void> {
    for (;;) {
      this.expire();
      if (!this.stopped)
        for (const j of this.order(
          this.store.all<Job>('jobs').filter((j) => j.status === 'queued'),
        )) {
          if ((j.executor_mode !== 'direct' && j.executor_mode !== 'session') || !this.capacity(j))
            continue;
          const executor = this.executors[j.executor_mode];
          if (!executor) continue;
          try {
            this.store.transaction(() => this.begin(j));
          } catch (error) {
            if (error instanceof CuratorError && error.code === 'budget_exceeded') {
              j.status = 'failed';
              j.error = error.toJSON();
              this.save(j);
            }
            continue;
          }
          const abort = new AbortController();
          let timer: ReturnType<typeof setTimeout>;
          const timeout = new Promise<never>((_, reject) => {
            abort.signal.addEventListener(
              'abort',
              () =>
                reject(
                  new CuratorError('unknown_outcome', 'Executor interrupted after acceptance'),
                ),
              { once: true },
            );
            timer = setTimeout(
              () => {
                abort.abort();
                reject(new CuratorError('unknown_outcome', 'Executor timed out after acceptance'));
              },
              (j.execution.timeout_sec ?? 300) * 1000,
            );
          });
          const promise = Promise.race([executor({ job: j, signal: abort.signal }), timeout])
            .then((r) => this.finish(j, r))
            .then(() => {})
            .catch((error) => {
              const current = this.get(j, j.job_id);
              if (current.status !== 'running') return;
              const rejected =
                error instanceof ExecutorPreflightError ? error.toJSON() : providerRejection(error);
              if (rejected) {
                current.status = 'failed';
                current.error = rejected;
                this.store.transaction(() => {
                  this.settle(current, 0, true);
                  this.save(current);
                  this.store.emit(
                    'job.failed',
                    current,
                    current.requested_by,
                    current.job_id,
                    { code: rejected.code },
                    current.correlation_id,
                  );
                });
                return;
              }
              this.unknown(
                current,
                error instanceof CuratorError
                  ? error.message
                  : 'Executor connection failed after acceptance',
              );
            })
            .finally(() => {
              clearTimeout(timer!);
              this.active.delete(j.job_id);
            });
          this.active.set(j.job_id, { abort, promise });
        }
      const running = [...this.active.values()].map((a) => a.promise);
      if (!running.length) return;
      await Promise.allSettled(running);
    }
  }
  stop(): void {
    this.stopped = true;
    for (const [id, run] of this.active) {
      run.abort.abort();
      const j = this.store.get<Job>('jobs', id);
      if (j?.status === 'running') this.unknown(j, 'Shutdown after executor accepted work');
    }
  }
  status(scope?: Scope) {
    this.expire();
    const jobs = scope ? this.list(scope) : this.store.all<Job>('jobs');
    return {
      total: jobs.length,
      active: jobs.filter((j) => j.status === 'running').length,
      unknown: jobs.filter((j) => j.status === 'unknown_outcome').length,
      cost: jobs.reduce((s, j) => s + j.cost, 0),
    };
  }
}
