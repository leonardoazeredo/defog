import type { KeyState } from "../platform/watchLinkModule.js";
import { NotADatabaseError, type SqlDriver } from "./driver.js";
import type { DatabaseKeyHex } from "./keyHex.js";
import { type KeyPresence, keyIsLostOrUnreadable } from "./keyState.js";

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
  keyPresence(): Promise<KeyPresence>;
  /** The full state; asked only after a read of a present key failed, which unwraps it again. */
  keyState(): Promise<KeyState>;
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
  const readKey = async (): Promise<DatabaseKeyHex | null> => {
    try {
      return await deps.getDatabaseKeyHex();
    } catch (e) {
      if (deps.isKeyLostError(e)) return null;
      throw e;
    }
  };
  // With no database file the key protects nothing, so it is dropped and the next read mints a
  // new one, rather than asking for a restore on every start.
  const resetUnlessDatabase = async (): Promise<boolean> => {
    if (deps.databaseExists()) return false;
    await deps.resetKeys();
    return true;
  };

  const presence = await deps.keyPresence();
  if (presence === "fresh" && deps.databaseExists()) return { kind: "keyLost" };
  if (presence === "lost" && !(await resetUnlessDatabase())) return { kind: "keyLost" };

  let keyHex = await readKey();
  if (keyHex === null && presence === "existing") {
    // Both halves are there but the read failed, so the state is worth the second unwrap: only a
    // key that can never read (or whose Keystore half is empty) is dropped.
    if (keyIsLostOrUnreadable(await deps.keyState()) && (await resetUnlessDatabase())) {
      keyHex = await readKey();
    }
  }
  if (keyHex === null) return { kind: "keyLost" };
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
