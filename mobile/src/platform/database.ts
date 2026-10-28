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
import { migrate, NewerSchemaError } from "../db/schema.js";
import { warnClass } from "../flows/warn.js";
import { createDatabaseFiles } from "./backupPlatform.js";
import { createExpoSqliteDriver } from "./expoSqliteDriver.js";
import { getDatabaseKeyHex, KeyLostError, keyState, resetKeys } from "./watchLinkModule.js";

let opened: Promise<HistoryDatabase> | undefined;
// Only the first open of the process keeps, puts back or discards a replaced copy; a missing live file is recovered on every open.
let recovered = false;

// SQLite's words for a file whose pages are damaged: no later open reads it either.
const CORRUPT_FILE = /database disk image is malformed|SQLITE_CORRUPT/i;

/**
 * Whether a failure of the first open (the driver's open or the migration) proves this build can
 * never use the restored live file, so putting the replaced copy back (which deletes the restored
 * live file and its sidecars) loses nothing a later open could read: a key that does not open it
 * (NotADatabaseError; the key is the same on every open, and a Keystore that cannot answer throws
 * KeyUnavailableError instead), a schema from a newer app, or a damaged file. Anything else, a
 * device fault or a bug, is not proof, and deleting the file on it would lose the restore.
 */
function restoredFileUnusable(e: unknown): boolean {
  if (e instanceof NotADatabaseError || e instanceof NewerSchemaError) return true;
  return e instanceof Error && CORRUPT_FILE.test(e.message);
}

/** Store calls run shared; a restore runs exclusive, so none is midway through the file it swaps. */
export const historyGate = createGate();

/** Opens the history database once; later callers share the result, and a failed open is retried by the next caller. */
export function createDatabase(): Promise<HistoryDatabase> {
  opened ??= (async () => {
    const files = createDatabaseFiles();
    // A swap that left no live file must never be answered with a fresh empty one; this is safe at any time.
    recoverInterruptedReplace(files);
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
        migrate,
        isKeyLostError: (e) => e instanceof KeyLostError,
      });
    if (recovered) return open().catch(wrongKeyAsKeyLost);
    // First open of the process: a replaced copy still beside the live file means a restore did not
    // finish, so it is kept until the live file has opened and migrated. If the live file's open
    // returns key-lost, the copy stays beside it. Only a live file restoredFileUnusable condemns is
    // deleted with its sidecars, and the copy moved back onto the live path and opened instead, so
    // the old file still gets its chance; that one reads as key-lost when the key is wrong. Any
    // other throw rejects with both files left in place and the next open decides again.
    // With no copy, a key that is wrong reads as key-lost at once and any other throw rejects as itself.
    let history: HistoryDatabase;
    try {
      history = await open();
    } catch (e) {
      if (!files.exists(REPLACED_DB)) {
        history = wrongKeyAsKeyLost(e);
      } else if (restoredFileUnusable(e)) {
        // The restore is undone here with no word to the owner, so the log is the only trace of why.
        warnClass("restore", "put-back", e);
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
