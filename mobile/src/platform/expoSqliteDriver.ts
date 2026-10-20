import type { SqlDriver, SqlTx, SqlValue } from "../db/driver.js";

/** The slice of expo-sqlite's `SQLiteDatabase` the driver uses; a transaction connection has the same one. */
export interface ExpoDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: SqlValue[]): Promise<{ changes: number }>;
  getAllAsync<T>(sql: string, params: SqlValue[]): Promise<T[]>;
  closeAsync(): Promise<void>;
  withExclusiveTransactionAsync(task: (txn: ExpoDb) => Promise<void>): Promise<void>;
}

export interface ExpoSqliteDriverOptions {
  name: string;
  keyHex: string;
  open?: (name: string) => Promise<ExpoDb>;
}

async function defaultOpen(name: string): Promise<ExpoDb> {
  const { openDatabaseAsync } = await import("expo-sqlite");
  return (await openDatabaseAsync(name)) as unknown as ExpoDb;
}

function wrap(db: ExpoDb): SqlTx {
  return {
    exec: (sql) => db.execAsync(sql),
    async run(sql, params = []) {
      const r = await db.runAsync(sql, params);
      return { changes: r.changes };
    },
    all: (sql, params = []) => db.getAllAsync(sql, params),
  };
}

export async function createExpoSqliteDriver(opts: ExpoSqliteDriverOptions): Promise<SqlDriver> {
  // The key goes into a PRAGMA, which cannot take a bound parameter; only 32 bytes of hex may reach it.
  if (!/^[0-9a-f]{64}$/.test(opts.keyHex)) throw new Error("database key must be 64 hex digits");
  const keyPragma = `PRAGMA key = "x'${opts.keyHex}'"`;

  const db = await (opts.open ?? defaultOpen)(opts.name);
  try {
    await db.execAsync(keyPragma);
    // Without SQLCipher in the build PRAGMA key is a silent no-op and the history would be plaintext.
    const cipher = await db.getAllAsync<unknown>("PRAGMA cipher_version", []);
    if (cipher.length === 0) throw new Error("expo-sqlite was built without SQLCipher");
    // The first read fails with "file is not a database" when the key is wrong.
    await db.getAllAsync("SELECT count(*) FROM sqlite_master", []);
    await db.execAsync("PRAGMA journal_mode = WAL");
  } catch (e) {
    await db.closeAsync().catch(() => undefined);
    throw e;
  }

  let tail: Promise<unknown> = Promise.resolve();
  return {
    ...wrap(db),
    transaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        let result: { value: T } | undefined;
        await db.withExclusiveTransactionAsync(async (txn) => {
          // The exclusive transaction opens its own connection, which starts unkeyed, so key it before the callback runs.
          await txn.execAsync(keyPragma);
          result = { value: await fn(wrap(txn)) };
        });
        if (!result) throw new Error("transaction did not run");
        return result.value;
      };
      const next = tail.then(run, run);
      tail = next.catch(() => undefined);
      return next;
    },
    async close() {
      await tail;
      await db.closeAsync();
    },
  };
}
