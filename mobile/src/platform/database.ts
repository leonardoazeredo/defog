import { File, Paths } from "expo-file-system";
import {
  discardReplacedCopy,
  LIVE_DB,
  putBackReplacedCopy,
  REPLACED_DB,
  recoverInterruptedReplace,
} from "../backup/replace.js";
import { createGate } from "../db/gate.js";
import { type HistoryDatabase, openHistory, wrongKeyAsKeyLost } from "../db/openHistory.js";
import { migrate } from "../db/schema.js";
import { createDatabaseFiles } from "./backupPlatform.js";
import { createExpoSqliteDriver } from "./expoSqliteDriver.js";
import { getDatabaseKeyHex, KeyLostError, keyState, resetKeys } from "./watchLinkModule.js";

let opened: Promise<HistoryDatabase> | undefined;
// Only the first open of the process keeps, puts back or discards a replaced copy; a missing live file is recovered on every open.
let recovered = false;

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
    // returns key-lost, the copy stays beside it. If that open throws anything (a busy Keystore
    // included), the live file and its sidecars are deleted and the copy is moved back onto the
    // live path and opened instead, so the old file still gets its chance; a file that will not
    // open with the key (NotADatabaseError: a wrong key or no database) then reads as key-lost.
    // With no copy, such a file reads as key-lost at once and any other throw rejects as itself.
    let history: HistoryDatabase;
    try {
      history = await open();
    } catch (e) {
      if (!files.exists(REPLACED_DB)) {
        history = wrongKeyAsKeyLost(e);
      } else {
        putBackReplacedCopy(files);
        history = await open().catch(wrongKeyAsKeyLost);
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
