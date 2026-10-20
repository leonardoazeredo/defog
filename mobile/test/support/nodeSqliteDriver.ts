import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDriver, SqlTx, SqlValue } from "../../src/db/driver.js";

// No SQLCipher here: this driver exercises schema and store logic only; keying is checked on the emulator.
export function createNodeSqliteDriver(path: string | ":memory:"): SqlDriver {
  const db = new DatabaseSync(path);
  let tail: Promise<unknown> = Promise.resolve();

  const base: SqlTx = {
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
    async close() {
      await tail;
      db.close();
    },
  };
  return driver;
}
