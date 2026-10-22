import { File, Paths } from "expo-file-system";
import {
  discardReplacedCopy,
  LIVE_DB,
  putBackReplacedCopy,
  REPLACED_DB,
  recoverInterruptedReplace,
} from "../backup/replace.js";
import { createGate } from "../db/gate.js";
import { type HistoryDatabase, openHistory } from "../db/openHistory.js";
import { migrate } from "../db/schema.js";
import { createDatabaseFiles } from "./backupPlatform.js";
import { createExpoSqliteDriver } from "./expoSqliteDriver.js";
import { getDatabaseKeyHex, KeyLostError, keyState } from "./watchLinkModule.js";

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
        // expo-sqlite's default directory is `SQLite` under the document directory.
        databaseExists: () => new File(Paths.document, "SQLite", LIVE_DB).exists,
        openDriver: (keyHex) => createExpoSqliteDriver({ name: LIVE_DB, keyHex }),
        migrate,
        isKeyLostError: (e) => e instanceof KeyLostError,
      });
    if (recovered) return open();
    // First open of the process: a replaced copy still beside the live file means a restore did not finish,
    // so it is kept until the live file has opened and migrated, and comes back if opening throws (a key-lost result leaves it beside the live file).
    let history: HistoryDatabase;
    try {
      history = await open();
    } catch (e) {
      if (!files.exists(REPLACED_DB)) throw e;
      putBackReplacedCopy(files);
      history = await open();
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
