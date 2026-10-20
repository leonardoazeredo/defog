import { describe, expect, it } from "vitest";
import { createExpoSqliteDriver, type ExpoDb } from "../../../src/platform/expoSqliteDriver.js";

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
});
