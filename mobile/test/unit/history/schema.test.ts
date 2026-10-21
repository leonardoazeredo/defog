import { describe, expect, it } from "vitest";
import { migrate } from "../../../src/db/schema.js";
import { createNodeSqliteDriver } from "../../support/nodeSqliteDriver.js";

const tables = (db: ReturnType<typeof createNodeSqliteDriver>) =>
  db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");

describe("migrate", () => {
  it("creates the three tables on an empty database and sets user_version 1", async () => {
    const db = createNodeSqliteDriver(":memory:");
    expect(await migrate(db)).toBe(1);
    expect((await tables(db)).map((t) => t.name)).toEqual(["activities", "blobs", "routes"]);
    const [v] = await db.all<{ user_version: number }>("PRAGMA user_version");
    expect(v?.user_version).toBe(1);
  });

  it("changes nothing when run again", async () => {
    const db = createNodeSqliteDriver(":memory:");
    await migrate(db);
    await db.run("INSERT INTO blobs (kind, name, bytes) VALUES ('a', 'b', ?)", [
      new Uint8Array([1]),
    ]);
    expect(await migrate(db)).toBe(1);
    expect(await db.all("SELECT * FROM blobs")).toHaveLength(1);
  });

  it("refuses a database from a newer app", async () => {
    const db = createNodeSqliteDriver(":memory:");
    await db.exec("PRAGMA user_version = 2");
    await expect(migrate(db)).rejects.toThrow(/newer/);
  });

  it("rolls the migration back when a step fails", async () => {
    const db = createNodeSqliteDriver(":memory:");
    await db.exec("CREATE TABLE routes (id TEXT)");
    await expect(migrate(db)).rejects.toThrow();
    expect((await tables(db)).map((t) => t.name)).toEqual(["routes"]);
    const [v] = await db.all<{ user_version: number }>("PRAGMA user_version");
    expect(v?.user_version).toBe(0);
  });
});

describe("transaction", () => {
  it("rolls back when the callback throws", async () => {
    const db = createNodeSqliteDriver(":memory:");
    await db.exec("CREATE TABLE t (x INTEGER)");
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO t VALUES (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.all("SELECT * FROM t")).toEqual([]);
  });

  it("commits and returns the callback's value", async () => {
    const db = createNodeSqliteDriver(":memory:");
    await db.exec("CREATE TABLE t (x INTEGER)");
    const out = await db.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES (1)");
      return "done";
    });
    expect(out).toBe("done");
    expect(await db.all("SELECT * FROM t")).toHaveLength(1);
  });

  it("runs overlapping transactions one after the other", async () => {
    const db = createNodeSqliteDriver(":memory:");
    await db.exec("CREATE TABLE t (x INTEGER)");
    await Promise.all(
      [1, 2, 3].map((n) =>
        db.transaction(async (tx) => {
          await tx.run("INSERT INTO t VALUES (?)", [n]);
          await Promise.resolve();
        }),
      ),
    );
    expect(await db.all("SELECT x FROM t ORDER BY x")).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
  });
});
