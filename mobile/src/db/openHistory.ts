import { NotADatabaseError, type SqlDriver } from "./driver.js";
import type { DatabaseKeyHex } from "./keyHex.js";

export type HistoryDatabase = { kind: "ready"; db: SqlDriver } | { kind: "keyLost" };

/**
 * Thrown by `open()` in `src/platform/historyStores.ts` while the key is lost, so the history flow can skip
 * its list notice (the startup alert already says so); a failed open rejects with its own error instead.
 */
export class HistoryKeyLostError extends Error {
  override name = "HistoryKeyLostError";
}

/**
 * A key that reads but does not open the file (a wrong key, or a file that is no database: SQLCipher
 * cannot tell them apart) is as good as lost: the owner is asked for a restore instead of seeing an
 * open that fails on every start.
 */
export function wrongKeyAsKeyLost(e: unknown): HistoryDatabase {
  if (e instanceof NotADatabaseError) return { kind: "keyLost" };
  throw e;
}

export interface OpenHistoryDeps {
  keyState(): Promise<"fresh" | "existing" | "lost" | "unreadable">;
  getDatabaseKeyHex(): Promise<DatabaseKeyHex>;
  /** Whether a database file (the live one or a restore's replaced copy) is already on disk. */
  databaseExists(): boolean;
  /**
   * Drops a lost or unreadable database key so the next read mints one; native refuses while the
   * live database or a restore's replaced copy exists.
   */
  resetKeys(): Promise<void>;
  openDriver(keyHex: DatabaseKeyHex): Promise<SqlDriver>;
  migrate(db: SqlDriver): Promise<number>;
  isKeyLostError(e: unknown): boolean;
}

// A lost or unreadable key next to an existing database must never fall through to creating an
// empty one: the owner would see a blank history and could overwrite what a backup can still restore.
export async function openHistory(deps: OpenHistoryDeps): Promise<HistoryDatabase> {
  const state = await deps.keyState();
  if (state === "lost" || state === "unreadable") {
    if (deps.databaseExists()) return { kind: "keyLost" };
    // With no database file the key protects nothing, so it is dropped and the next read mints a
    // new one, rather than asking for a restore on every start.
    await deps.resetKeys();
  } else if (state === "fresh" && deps.databaseExists()) {
    return { kind: "keyLost" };
  }

  let keyHex: DatabaseKeyHex;
  try {
    keyHex = await deps.getDatabaseKeyHex();
  } catch (e) {
    if (deps.isKeyLostError(e)) return { kind: "keyLost" };
    throw e;
  }
  const db = await deps.openDriver(keyHex);
  try {
    await deps.migrate(db);
  } catch (e) {
    // The migration's error is the one worth reporting; the close's class is only logged.
    await db.close().catch((closeError: unknown) => {
      console.warn(
        "crossfog: history close failed",
        closeError instanceof Error ? closeError.name : "unknown",
      );
    });
    throw e;
  }
  return { kind: "ready", db };
}
