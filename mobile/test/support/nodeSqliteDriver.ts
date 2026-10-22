import { copyFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  type AttachedBackup,
  NotADatabaseError,
  type OpenBackup,
  type SqlDriver,
  type SqlTx,
  type SqlValue,
} from "../../src/db/driver.js";

// No SQLCipher here: this driver exercises schema and store logic only; keying is checked on the emulator.
// Exports remember the key each file was written with, so a wrong key is refused the way SQLCipher
// refuses it; that is a simulation, not encryption.
const keysByPath = new Map<string, string | null>();

/** Copies an exported file and the key it was written with, as a byte copy of a real file would. */
export function copyNodeBackup(from: string, to: string): void {
  copyFileSync(from, to);
  if (keysByPath.has(from)) keysByPath.set(to, keysByPath.get(from) ?? null);
}

function wrapDb(db: DatabaseSync): SqlTx {
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params = []) {
      const r = db.prepare(sql).run(...(params as SQLInputValue[]));
      return { changes: Number(r.changes) };
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
  };
}

function quote(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

/** Copies every table (schema from sqlite_master, so primary keys and constraints survive; indexes, views and triggers are not copied) and the user version from `from` to `to`. */
function copyAll(db: DatabaseSync, from: string, to: string): void {
  const tables = db
    .prepare(
      `SELECT name, sql FROM ${from}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as { name: string; sql: string }[];
  for (const t of tables) {
    db.exec(t.sql.replace(/^CREATE TABLE (\S+)/, `CREATE TABLE ${to}.$1`));
    db.exec(`INSERT INTO ${to}.${t.name} SELECT * FROM ${from}.${t.name}`);
  }
  const [v] = db.prepare(`PRAGMA ${from}.user_version`).all() as { user_version: number }[];
  db.exec(`PRAGMA ${to}.user_version = ${Number(v?.user_version ?? 0)}`);
}

export const openNodeBackup: OpenBackup = async (path, key) => {
  if (keysByPath.has(path) && keysByPath.get(path) !== key) {
    throw new NotADatabaseError("file is not a database");
  }
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`ATTACH DATABASE ${quote(path)} AS backup`);
    db.prepare("SELECT count(*) FROM backup.sqlite_master").all();
  } catch (e) {
    db.close();
    if (e instanceof Error && /not a database/i.test(e.message)) {
      throw new NotADatabaseError("file is not a database");
    }
    throw e;
  }
  const attached: AttachedBackup = {
    ...wrapDb(db),
    async exportTo(target, targetKey) {
      db.exec(`ATTACH DATABASE ${quote(target)} AS out`);
      copyAll(db, "backup", "out");
      db.exec("DETACH DATABASE out");
      keysByPath.set(target, targetKey);
    },
    async close() {
      db.close();
    },
  };
  return attached;
};
export function createNodeSqliteDriver(path: string | ":memory:"): SqlDriver {
  const db = new DatabaseSync(path);
  let tail: Promise<unknown> = Promise.resolve();

  const base = wrapDb(db);

  const driver: SqlDriver = {
    ...base,
    transaction(fn) {
      const run = async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const out = await fn(base);
          db.exec("COMMIT");
          return out;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      };
      const next = tail.then(run, run);
      tail = next.catch(() => undefined);
      return next;
    },
    async exportTo(target, key) {
      await tail;
      db.exec(`ATTACH DATABASE ${quote(target)} AS backup`);
      copyAll(db, "main", "backup");
      db.exec("DETACH DATABASE backup");
      keysByPath.set(target, key);
    },
    async close() {
      await tail;
      db.close();
    },
  };
  return driver;
}
