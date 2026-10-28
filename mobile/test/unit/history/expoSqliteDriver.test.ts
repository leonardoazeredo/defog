import { describe, expect, it } from "vitest";
import { NotADatabaseError } from "../../../src/db/driver.js";
import {
  createExpoSqliteDriver,
  createOpenBackup,
  type ExpoDb,
} from "../../../src/platform/expoSqliteDriver.js";

const KEY = "ab".repeat(32);
const PRAGMA = `PRAGMA key = "x'${KEY}'"`;

// Records each statement per connection, in order, so a test can see what each connection ran first.
function fakeDb(log: string[][], opts: { cipher?: boolean } = {}): ExpoDb {
  const conn: string[] = [];
  log.push(conn);
  const self: ExpoDb = {
    async execAsync(sql) {
      conn.push(sql);
    },
    async runAsync(sql) {
      conn.push(sql);
      return { changes: 1 };
    },
    async getAllAsync<T>(sql: string) {
      conn.push(sql);
      return (sql === "PRAGMA cipher_version" && opts.cipher === false ? [] : [{}]) as T[];
    },
    async closeAsync() {
      conn.push("close");
    },
    async withExclusiveTransactionAsync(task) {
      await task(fakeDb(log, opts));
    },
  };
  return self;
}

describe("expo sqlite driver", () => {
  it("keys the main connection before anything else", async () => {
    const log: string[][] = [];
    await createExpoSqliteDriver({ name: "x.db", keyHex: KEY, open: async () => fakeDb(log) });
    expect(log[0]?.[0]).toBe(PRAGMA);
    expect(log[0]).toContain("PRAGMA journal_mode = WAL");
  });

  it("keys the exclusive transaction's own connection before the callback's first statement", async () => {
    const log: string[][] = [];
    const db = await createExpoSqliteDriver({
      name: "x.db",
      keyHex: KEY,
      open: async () => fakeDb(log),
    });
    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES (1)");
    });
    expect(log).toHaveLength(2);
    expect(log[1]).toEqual([PRAGMA, "INSERT INTO t VALUES (1)"]);
  });

  it("keys a fresh connection for every transaction", async () => {
    const log: string[][] = [];
    const db = await createExpoSqliteDriver({
      name: "x.db",
      keyHex: KEY,
      open: async () => fakeDb(log),
    });
    await db.transaction(async () => {});
    await db.transaction(async () => {});
    expect(log.slice(1).map((c) => c[0])).toEqual([PRAGMA, PRAGMA]);
  });

  it("rejects a key that is not 64 hex digits without opening anything", async () => {
    const log: string[][] = [];
    await expect(
      createExpoSqliteDriver({
        name: "x.db",
        keyHex: `${KEY}"; DROP`,
        open: async () => fakeDb(log),
      }),
    ).rejects.toThrow(/64 hex/);
    expect(log).toHaveLength(0);
  });

  it("refuses a build without SQLCipher and closes the connection", async () => {
    const log: string[][] = [];
    await expect(
      createExpoSqliteDriver({
        name: "x.db",
        keyHex: KEY,
        open: async () => fakeDb(log, { cipher: false }),
      }),
    ).rejects.toThrow(/SQLCipher/);
    expect(log[0]?.at(-1)).toBe("close");
  });

  it("returns the callback's value and passes its error on", async () => {
    const log: string[][] = [];
    const db = await createExpoSqliteDriver({
      name: "x.db",
      keyHex: KEY,
      open: async () => fakeDb(log),
    });
    expect(await db.transaction(async () => 7)).toBe(7);
    await expect(
      db.transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("runs overlapping transactions one after the other", async () => {
    const log: string[][] = [];
    const db = await createExpoSqliteDriver({
      name: "x.db",
      keyHex: KEY,
      open: async () => fakeDb(log),
    });
    const order: string[] = [];
    const slow = db.transaction(async () => {
      order.push("a start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("a end");
    });
    const fast = db.transaction(async () => {
      order.push("b start");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a start", "a end", "b start"]);
  });

  it("keeps running transactions after one fails", async () => {
    const log: string[][] = [];
    const db = await createExpoSqliteDriver({
      name: "x.db",
      keyHex: KEY,
      open: async () => fakeDb(log),
    });
    await expect(
      db.transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.transaction(async () => "next")).toBe("next");
  });

  it("closes the connection and passes the error on when the key is wrong", async () => {
    const log: string[][] = [];
    const wrongKey = async () => {
      const db = fakeDb(log);
      db.getAllAsync = async <T>(sql: string) => {
        if (sql.startsWith("SELECT")) throw new Error("file is not a database");
        return [{}] as T[];
      };
      return db;
    };
    await expect(
      createExpoSqliteDriver({ name: "x.db", keyHex: KEY, open: wrongKey }),
    ).rejects.toThrow("file is not a database");
    expect(log[0]?.at(-1)).toBe("close");
  });
});

describe("expo sqlite driver export", () => {
  // Records statements with their bound parameters on one connection.
  function exportDb(opts: { failExport?: boolean } = {}) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const db = fakeDb([]);
    const wrapped: ExpoDb = {
      ...db,
      async execAsync(sql) {
        calls.push({ sql });
      },
      async runAsync(sql, params) {
        calls.push({ sql, params });
        return { changes: 0 };
      },
      async getAllAsync<T>(sql: string, params: unknown[]) {
        calls.push({ sql, params });
        if (sql.startsWith("SELECT sqlcipher_export") && opts.failExport) throw new Error("boom");
        return (sql.includes("user_version") ? [{ user_version: 1 }] : [{}]) as T[];
      },
    };
    return { calls, wrapped };
  }

  it("binds the path and the passphrase, so a quote in it cannot reach the statement", async () => {
    const { calls, wrapped } = exportDb();
    const driver = await createExpoSqliteDriver({
      name: "x.db",
      keyHex: KEY,
      open: async () => wrapped,
    });
    calls.length = 0;
    await driver.exportTo("/cache/b.db", "pa'ss");
    const attach = calls.find((c) => c.sql.startsWith("ATTACH"));
    expect(attach).toEqual({
      sql: "ATTACH DATABASE ? AS backup KEY ?",
      params: ["/cache/b.db", "pa'ss"],
    });
    expect(calls.map((c) => c.sql).join("\n")).not.toContain("pa'ss");
    expect(calls.map((c) => c.sql)).toContain("PRAGMA backup.user_version = 1");
  });

  it("writes an unencrypted copy with an empty key", async () => {
    const { calls, wrapped } = exportDb();
    const driver = await createExpoSqliteDriver({
      name: "x.db",
      keyHex: KEY,
      open: async () => wrapped,
    });
    calls.length = 0;
    await driver.exportTo("/cache/b.db", null);
    expect(calls.find((c) => c.sql.startsWith("ATTACH"))?.params).toEqual(["/cache/b.db", ""]);
  });

  it("detaches even when the export fails", async () => {
    const { calls, wrapped } = exportDb({ failExport: true });
    const driver = await createExpoSqliteDriver({
      name: "x.db",
      keyHex: KEY,
      open: async () => wrapped,
    });
    await expect(driver.exportTo("/cache/b.db", "k")).rejects.toThrow("boom");
    expect(calls.at(-1)?.sql).toBe("DETACH DATABASE backup");
  });

  it("maps SQLite's 'not a database' to NotADatabaseError and closes the connection", async () => {
    const closed: string[] = [];
    const open = createOpenBackup(async () => ({
      ...fakeDb([]),
      async runAsync() {
        return { changes: 0 };
      },
      async getAllAsync() {
        throw new Error("Error code 26: file is not a database");
      },
      async closeAsync() {
        closed.push("close");
      },
    }));
    await expect(open("/cache/b.db", "wrong")).rejects.toBeInstanceOf(NotADatabaseError);
    expect(closed).toEqual(["close"]);
  });

  it("lets any other failure through unchanged", async () => {
    const open = createOpenBackup(async () => ({
      ...fakeDb([]),
      async runAsync() {
        throw new Error("disk I/O error");
      },
    }));
    await expect(open("/cache/b.db", null)).rejects.toThrow("disk I/O error");
  });
});

// A main connection that refuses any call while an exclusive transaction is open, as the real
// one can ("database is locked"); the transaction's own connection never refuses.
function lockingDb(events: string[], gate: { open: boolean }): ExpoDb {
  const refuse = (what: string) => {
    if (gate.open) throw new Error(`database is locked: ${what}`);
    events.push(what);
  };
  return {
    async execAsync(sql) {
      refuse(sql);
    },
    async runAsync(sql) {
      refuse(sql);
      return { changes: 1 };
    },
    async getAllAsync<T>(sql: string) {
      refuse(sql);
      return [{}] as T[];
    },
    async closeAsync() {},
    async withExclusiveTransactionAsync(task) {
      gate.open = true;
      events.push("begin");
      try {
        await task({
          async execAsync(sql) {
            events.push(`tx ${sql}`);
          },
          async runAsync(sql) {
            events.push(`tx ${sql}`);
            return { changes: 1 };
          },
          async getAllAsync<T>(sql: string) {
            events.push(`tx ${sql}`);
            return [] as T[];
          },
          async closeAsync() {},
          async withExclusiveTransactionAsync() {},
        });
      } finally {
        gate.open = false;
        events.push("commit");
      }
    },
  };
}

describe("expo sqlite driver plain queries beside a transaction", () => {
  async function setup() {
    const events: string[] = [];
    const gate = { open: false };
    const db = await createExpoSqliteDriver({
      name: "x.db",
      keyHex: KEY,
      open: async () => lockingDb(events, gate),
    });
    events.length = 0;
    return { db, events };
  }

  it("holds run, all and exec until the open transaction has committed", async () => {
    const { db, events } = await setup();
    const tx = db.transaction(async (t) => {
      await t.run("INSERT 1");
      await new Promise((r) => setTimeout(r, 10));
      await t.run("INSERT 2");
    });
    await Promise.all([tx, db.run("RUN"), db.all("ALL"), db.exec("EXEC")]);
    expect(events).toEqual([
      "begin",
      `tx ${PRAGMA}`,
      "tx INSERT 1",
      "tx INSERT 2",
      "commit",
      "RUN",
      "ALL",
      "EXEC",
    ]);
  });

  it("lets a plain query issued first finish before the transaction begins", async () => {
    const { db, events } = await setup();
    await Promise.all([db.run("RUN"), db.transaction(async () => {})]);
    expect(events.slice(0, 2)).toEqual(["RUN", "begin"]);
  });

  it("keeps serving plain queries after a transaction fails", async () => {
    const { db, events } = await setup();
    const failing = db.transaction(async () => {
      throw new Error("boom");
    });
    const after = db.all("AFTER");
    await expect(failing).rejects.toThrow("boom");
    await after;
    expect(events.at(-1)).toBe("AFTER");
  });

  it("runs the callback's own queries on the transaction connection, not the queue", async () => {
    const { db, events } = await setup();
    await db.transaction(async (tx) => {
      await tx.exec("A");
      await tx.all("B");
      await tx.run("C");
    });
    expect(events).toEqual(["begin", `tx ${PRAGMA}`, "tx A", "tx B", "tx C", "commit"]);
  });

  it("waits for queued plain queries before closing", async () => {
    const { db, events } = await setup();
    const run = db.run("LAST");
    await db.close();
    await run;
    expect(events).toContain("LAST");
  });
});
