import { openDatabase, type DatabasePort } from './database.js';
import {
  mkdirSync,
  openSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  closeSync,
  chmodSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Scope } from './types.js';
import { now } from './types.js';
import { ensure } from './errors.js';

export const tables = [
  'skills',
  'skill_versions',
  'sessions',
  'learning_candidates',
  'proposals',
  'jobs',
  'job_attempts',
  'job_leases',
  'events',
  'audit_log',
  'settings',
  'usage',
  'idempotency',
  'publications',
  'control',
] as const;
export type Table = (typeof tables)[number];
export interface DurableEvent extends Scope {
  event_id: string;
  occurred_at: string;
  type: string;
  actor: string;
  correlation_id: string;
  entity_id: string;
  entity_revision?: number;
  details: Record<string, unknown>;
}
export class Store {
  readonly db: DatabasePort;
  private listeners = new Set<(event: DurableEvent) => void>();
  private pending: DurableEvent[] = [];
  private depth = 0;
  private lockPath: string;
  private lockToken = randomUUID();
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.lockPath = path + '.lock';
    try {
      const fd = openSync(this.lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken }));
      closeSync(fd);
    } catch (error) {
      let live = true;
      try {
        const previous = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid: number };
        try {
          process.kill(previous.pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') live = false;
        }
      } catch {
        /* unknown lock fails closed */
      }
      ensure(!live, 'rate_limited', 'Storage is already open in another instance');
      unlinkSync(this.lockPath);
      const fd = openSync(this.lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken }));
      closeSync(fd);
    }
    this.db = openDatabase(path);
    chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    this.db.transaction(() => {
      for (const table of tables)
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))`,
        );
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (1, ?)').run(now());
    })();
  }
  get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  all<T>(table: Table): T[] {
    return (
      this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]
    ).map((r) => JSON.parse(r.data) as T);
  }
  put(table: Table, id: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO ${table}(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(id, JSON.stringify(value));
  }
  delete(table: Table, id: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }
  transaction<T>(fn: () => T): T {
    const start = this.pending.length;
    this.depth++;
    try {
      const result = this.db.transaction(fn).immediate();
      this.depth--;
      if (this.depth === 0) {
        const events = this.pending.splice(0);
        for (const event of events)
          for (const listener of this.listeners) {
            try {
              listener(event);
            } catch {
              /* durable replay remains authoritative */
            }
          }
      }
      return result;
    } catch (error) {
      this.depth--;
      this.pending.splice(start);
      throw error;
    }
  }
  emit(
    type: string,
    scope: Scope,
    actor: string,
    entity_id: string,
    details: Record<string, unknown> = {},
    correlation_id: string = randomUUID(),
    entity_revision?: number,
  ): DurableEvent {
    const event = {
      event_id: randomUUID(),
      occurred_at: now(),
      type,
      tenant_id: scope.tenant_id,
      workspace_id: scope.workspace_id,
      actor,
      correlation_id,
      entity_id,
      entity_revision,
      details,
    };
    this.put('events', event.event_id, event);
    this.put('audit_log', event.event_id, event);
    if (this.depth) this.pending.push(event);
    else
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          /* replay */
        }
      }
    return event;
  }
  subscribe(listener: (event: DurableEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    if (this.db.open) this.db.close();
    try {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token: string };
      if (lock.token === this.lockToken) unlinkSync(this.lockPath);
    } catch {
      /* lock may have been removed by operator */
    }
  }
}
