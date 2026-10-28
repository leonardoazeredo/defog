import type { SqlDriver, SqlTx } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { createNodeSqliteDriver } from "./nodeSqliteDriver.js";

// Run as a child process by schema.test.ts: migrates the database at argv[2] and is killed
// outright on the second activity it copies, so the transaction is left
// uncommitted for the next open to roll back.
const db = createNodeSqliteDriver(process.argv[2] as string);
let copies = 0;
const killing = (tx: SqlTx): SqlTx => ({
  ...tx,
  async run(sql, params) {
    if (/INSERT INTO activities_v2/.test(sql) && ++copies === 2) {
      process.kill(process.pid, "SIGKILL");
    }
    return tx.run(sql, params);
  },
});
const driver: SqlDriver = { ...db, transaction: (fn) => db.transaction((tx) => fn(killing(tx))) };
await migrate(driver);
