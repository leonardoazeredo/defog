import { File, Paths } from "expo-file-system";
import {
  discardReplacedCopy,
  LIVE_DB,
  putBackReplacedCopy,
  REPLACED_DB,
  recoverInterruptedReplace,
} from "../backup/replace.js";
import { NotADatabaseError } from "../db/driver.js";
import { createGate } from "../db/gate.js";
import { type HistoryDatabase, openHistory, wrongKeyAsKeyLost } from "../db/openHistory.js";
import { migrate } from "../db/schema.js";
import { createDatabaseFiles } from "./backupPlatform.js";
import { createExpoSqliteDriver } from "./expoSqliteDriver.js";
import { getDatabaseKeyHex, KeyLostError, keyState, resetKeys } from "./watchLinkModule.js";

let opened: Promise<HistoryDatabase> | undefined;
// Only the first open of the process keeps, puts back or discards a replaced copy; a missing live file is recovered on every open.
let recovered = false;

// SQLite's words for a fault of the device rather than the file (a full disk, an I/O fault, a busy,
// locked, unopenable or read-only file, no memory or permission, a locking-protocol failure): a
// migration that stopped on one may succeed on the next open, so it says nothing about the file.
const PASSING_SQLITE_FAULT =
  /database or disk is full|disk I\/O error|database is locked|unable to open database file|out of memory|readonly database|SQLITE_(FULL|IOERR|BUSY|LOCKED|CANTOPEN|NOMEM|PERM|READONLY|PROTOCOL)/i;

/**
 * Whether a first open's failure is taken to say the restored live file cannot be used here, so the
 * replaced copy is put back (which deletes the restored live file and its sidecars). For
 * NotADatabaseError that is certain: the key is the same on every open (a Keystore that cannot
 * answer throws KeyUnavailableError instead), so a file it does not open now it never will. A
 * migration failure is an assumption: one that is not a device fault (PASSING_SQLITE_FAULT, matched
 * on the message) is blamed on the file.
 */
function restoredFileUnusable(e: unknown, migrationErrors: WeakSet<object>): boolean {
  if (e instanceof NotADatabaseError) return true;
  if (typeof e !== "object" || e === null || !migrationErrors.has(e)) return false;
  return !(e instanceof Error && PASSING_SQLITE_FAULT.test(e.message));
}

/** Store calls run shared; a restore runs exclusive, so none is midway through the file it swaps. */
export const historyGate = createGate();

/** Opens the history database once; later callers share the result, and a failed open is retried by the next caller. */
export function createDatabase(): Promise<HistoryDatabase> {
  opened ??= (async () => {
    const files = createDatabaseFiles();
    // A swap that left no live file must never be answered with a fresh empty one; this is safe at any time.
    recoverInterruptedReplace(files);
    // Errors migrate throws are recorded here, so restoredFileUnusable tells a failed migration from a
    // failed open or a failed read of the key.
    const migrationErrors = new WeakSet<object>();
    const open = () =>
      openHistory({
        keyState,
        getDatabaseKeyHex,
        // expo-sqlite's default directory is `SQLite` under the document directory. The replaced copy
        // counts too, as in the native resetKeys check.
        databaseExists: () =>
          [LIVE_DB, REPLACED_DB].some((name) => new File(Paths.document, "SQLite", name).exists),
        resetKeys,
        openDriver: (keyHex) => createExpoSqliteDriver({ name: LIVE_DB, keyHex }),
        migrate: (db) =>
          migrate(db).catch((e: unknown) => {
            if (typeof e === "object" && e !== null) migrationErrors.add(e);
            throw e;
          }),
        isKeyLostError: (e) => e instanceof KeyLostError,
      });
    if (recovered) return open().catch(wrongKeyAsKeyLost);
    // First open of the process: a replaced copy still beside the live file means a restore did not
    // finish, so it is kept until the live file has opened and migrated. If the live file's open
    // returns key-lost, the copy stays beside it. Only a live file that will not open with the key
    // (NotADatabaseError: a wrong key or no database) or will not migrate for a reason that does
    // not pass is deleted with its sidecars, and the copy moved back onto the live path and opened
    // instead, so the old file still gets its chance; that one reads as key-lost when the key is wrong.
    // Any other throw (a busy Keystore, a disk error) rejects with both files left in place and the
    // next open decides again, since the restored file may be the only copy of what was restored.
    // With no copy, a key that is wrong reads as key-lost at once and any other throw rejects as itself.
    let history: HistoryDatabase;
    try {
      history = await open();
    } catch (e) {
      if (!files.exists(REPLACED_DB)) {
        history = wrongKeyAsKeyLost(e);
      } else if (restoredFileUnusable(e, migrationErrors)) {
        putBackReplacedCopy(files);
        history = await open().catch(wrongKeyAsKeyLost);
      } else {
        throw e;
      }
    }
    recovered = true;
    if (history.kind === "ready") discardReplacedCopy(files);
    return history;
  })();
  const attempt = opened;
  attempt.catch(() => {
    // A newer open may have replaced this one already; only a failed open that is still current is forgotten.
    if (opened === attempt) opened = undefined;
  });
  return attempt;
}

/** Closes the open database and forgets it; the next `createDatabase` opens from the file. */
export async function closeDatabase(): Promise<void> {
  const pending = opened;
  opened = undefined;
  const history = await pending?.catch(() => undefined);
  if (history?.kind === "ready") await history.db.close();
}
