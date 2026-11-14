import { hash } from './security.js';
import { Store } from './store.js';
import { sameScope, type Scope, type Settings } from './types.js';

interface ActivityState extends Scope {
  kind: 'conversation-review';
  id: string;
  session_id: string;
  action_version: number;
  reviewed_version: number;
  last_action_at: number;
  updated_at: number;
  seen: string[];
  completion?: { event_id: string; action_version: number; at: number };
  retry_at: number;
  retry_generation: number;
  failures: number;
}

export interface ReviewDrainOptions {
  settings: Settings;
  paused: boolean;
  now?: number;
  readState: (sessionID: string) => Promise<{ idle: boolean; child?: boolean }>;
  run: (sessionID: string, idempotencyKey: string) => Promise<{ job_id: string }>;
}

/** Durable, per-conversation trigger. Contents and model execution belong to the caller. */
export class ConversationReview {
  private draining = false;

  constructor(
    private store: Store,
    private scope: Scope,
  ) {}

  private key(sessionID: string): string {
    return 'conversation-review:' + hash([this.scope, sessionID]);
  }

  private internal(sessionID: string): boolean {
    return (
      sessionID.startsWith('ses_curator_') || !!this.store.get('control', 'internal:' + sessionID)
    );
  }

  private get(sessionID: string, at: number): ActivityState {
    const id = this.key(sessionID);
    return (
      this.store.get<ActivityState>('control', id) ?? {
        ...this.scope,
        kind: 'conversation-review',
        id,
        session_id: sessionID,
        action_version: 0,
        reviewed_version: 0,
        last_action_at: at,
        updated_at: at,
        seen: [],
        retry_at: 0,
        retry_generation: 0,
        failures: 0,
      }
    );
  }

  private remember(row: ActivityState, type: string, eventID: string): boolean {
    const key = hash([type, eventID]);
    if (row.seen.includes(key)) return false;
    // Keep bounded replay protection across reloads without retaining tool inputs or outputs.
    row.seen = [...row.seen.slice(-511), key];
    return true;
  }

  activity(sessionID: string, eventID: string, at = Date.now()): void {
    if (this.internal(sessionID)) return;
    const row = this.get(sessionID, at);
    if (!this.remember(row, 'activity', eventID)) return;
    row.action_version++;
    row.last_action_at = at;
    row.updated_at = at;
    // Even failed tools count as useful experience; no review may run mid-response.
    delete row.completion;
    this.store.put('control', row.id, row);
  }

  completed(sessionID: string, eventID: string, at = Date.now()): void {
    if (this.internal(sessionID)) return;
    const row = this.store.get<ActivityState>('control', this.key(sessionID));
    if (!row) return;
    if (!this.remember(row, 'completed', eventID)) return;
    row.completion = { event_id: eventID, action_version: row.action_version, at };
    row.updated_at = at;
    this.store.put('control', row.id, row);
  }

  sessionStarted(sessionID: string, eventID?: string, at = Date.now()): void {
    if (this.internal(sessionID)) return;
    const row = this.store.get<ActivityState>('control', this.key(sessionID));
    if (!row) return;
    if (eventID && !this.remember(row, 'started', eventID)) return;
    delete row.completion;
    row.updated_at = at;
    this.store.put('control', row.id, row);
  }

  interrupted(sessionID: string, eventID?: string, at = Date.now()): void {
    this.sessionStarted(sessionID, eventID ? 'interrupted:' + eventID : undefined, at);
  }

  private rows(): ActivityState[] {
    return this.store
      .all<ActivityState>('control')
      .filter((row) => row.kind === 'conversation-review' && sameScope(row, this.scope));
  }

  private prune(settings: Settings, at: number): void {
    const expiry = at - settings.auto_learning.retention_days * 86_400_000;
    const rows = this.rows().sort((a, b) => b.updated_at - a.updated_at);
    for (const [index, row] of rows.entries()) {
      if (
        row.updated_at < expiry ||
        index >= settings.auto_learning.max_backlog ||
        this.internal(row.session_id)
      )
        this.store.delete('control', row.id);
    }
  }

  async drain(options: ReviewDrainOptions): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const { settings } = options;
      const at = options.now ?? Date.now();
      this.prune(settings, at);
      if (
        options.paused ||
        !settings.enabled ||
        !settings.auto_learning.enabled ||
        !settings.auto_learning.on_session_end ||
        !settings.conversation_review.enabled ||
        settings.auto_learning.quiet_hours.includes(new Date(at).getUTCHours())
      )
        return;
      const minimumAge = settings.conversation_review.min_age_sec * 1000;
      const debounce = settings.conversation_review.debounce_sec * 1000;
      for (const snapshot of this.rows()) {
        const completion = snapshot.completion;
        if (
          !completion ||
          snapshot.action_version - snapshot.reviewed_version <
            settings.conversation_review.every_n_actions ||
          completion.action_version !== snapshot.action_version ||
          at < Math.max(completion.at + minimumAge, snapshot.last_action_at + debounce) ||
          at < snapshot.retry_at
        )
          continue;
        try {
          const state = await options.readState(snapshot.session_id);
          if (!state.idle || (state.child && !settings.auto_learning.include_child_sessions))
            continue;
          // User activity may have arrived while native session state was being read.
          const current = this.store.get<ActivityState>('control', snapshot.id);
          if (
            !current ||
            this.internal(snapshot.session_id) ||
            current.action_version !== snapshot.action_version ||
            current.completion?.event_id !== completion.event_id
          )
            continue;
          const idempotencyKey =
            'conversation-review:' +
            hash([
              this.scope,
              snapshot.session_id,
              completion.event_id,
              snapshot.action_version,
              snapshot.retry_generation ?? 0,
            ]);
          const job = await options.run(snapshot.session_id, idempotencyKey);
          // Retain any new activity that arrived while the RPC was queuing this review.
          const latest = this.store.get<ActivityState>('control', snapshot.id);
          if (!latest) continue;
          latest.reviewed_version = Math.max(latest.reviewed_version, snapshot.action_version);
          latest.retry_at = 0;
          latest.retry_generation = 0;
          latest.failures = 0;
          this.store.transaction(() => {
            this.store.put('control', latest.id, latest);
            this.store.emit(
              'conversation_review.queued',
              this.scope,
              'system',
              snapshot.session_id,
              {
                job_id: job.job_id,
                actions: snapshot.action_version - snapshot.reviewed_version,
              },
            );
          });
        } catch (error) {
          const latest = this.store.get<ActivityState>('control', snapshot.id);
          if (!latest) continue;
          const code =
            error && typeof error === 'object' && 'code' in error ? error.code : undefined;
          // RPC idempotency also persists rejections. Only a definite rejection before
          // acceptance permits a new key; uncertain outcomes must keep their key.
          const rejected =
            typeof code === 'string' &&
            [
              'budget_exceeded',
              'executor_unavailable',
              'rate_limited',
              'validation_error',
              'revision_conflict',
              'not_found',
              'scope_violation',
            ].includes(code);
          if (rejected) latest.retry_generation = (latest.retry_generation ?? 0) + 1;
          latest.failures++;
          latest.retry_at =
            at + Math.min(3_600_000, 30_000 * 2 ** Math.min(latest.failures - 1, 7));
          this.store.transaction(() => {
            this.store.put('control', latest.id, latest);
            // Provider and context errors can contain credentials or transcript text.
            this.store.emit(
              'health.conversation_review_failed',
              this.scope,
              'system',
              snapshot.session_id,
              {
                retry_at: latest.retry_at,
                attempt: latest.failures,
                rejected_before_acceptance: rejected,
                reconciliation_required: code === 'unknown_outcome',
              },
            );
          });
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
