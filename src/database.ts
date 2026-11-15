import { createRequire } from 'node:module';
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
const require = createRequire(import.meta.url);
export interface Statement {
  get(...bindings: unknown[]): unknown;
  all(...bindings: unknown[]): unknown[];
  run(...bindings: unknown[]): unknown;
}
export interface DatabasePort {
  readonly driver: 'bun:sqlite' | 'better-sqlite3';
  readonly open: boolean;
  readonly inTransaction: boolean;
  prepare(sql: string): Statement;
  exec(sql: string): unknown;
  pragma(sql: string): unknown;
  transaction<T>(fn: () => T): { (): T; immediate(): T };
  close(): void;
  backup(path: string): Promise<unknown>;
}
export function openDatabase(path: string): DatabasePort {
  if (process.versions.bun) {
    const { Database } = require('bun:sqlite') as {
      Database: new (
        path: string,
      ) => Omit<DatabasePort, 'pragma' | 'driver' | 'open' | 'backup'> & { serialize(): Buffer };
    };
    const db = new Database(path);
    let open = true;
    return {
      driver: 'bun:sqlite',
      get open() {
        return open;
      },
      get inTransaction() {
        return db.inTransaction;
      },
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      pragma: (sql) => db.exec('PRAGMA ' + sql),
      transaction: (fn) => db.transaction(fn),
      close: () => {
        db.close();
        open = false;
      },
      backup: async (destination) => {
        const stage = destination + '.stage';
        const fd = openSync(stage, 'wx', 0o600);
        try {
          writeFileSync(fd, db.serialize());
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(stage, destination);
      },
    };
  }
  const Database = require('better-sqlite3') as new (path: string) => Omit<DatabasePort, 'driver'>;
  const db = new Database(path);
  return {
    driver: 'better-sqlite3',
    get open() {
      return db.open;
    },
    get inTransaction() {
      return db.inTransaction;
    },
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    pragma: (sql) => db.pragma(sql),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
    backup: (destination) => db.backup(destination),
  };
}
