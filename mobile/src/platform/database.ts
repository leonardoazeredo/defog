import { File, Paths } from "expo-file-system";
import { LIVE_DB, recoverInterruptedReplace } from "../backup/replace.js";
import { createGate } from "../db/gate.js";
import { type HistoryDatabase, openHistory } from "../db/openHistory.js";
import { migrate } from "../db/schema.js";
import { createDatabaseFiles } from "./backupPlatform.js";
import { createExpoSqliteDriver } from "./expoSqliteDriver.js";
import { getDatabaseKeyHex, KeyLostError, keyState } from "./watchLinkModule.js";

let opened: Promise<HistoryDatabase> | undefined;
// Only the first open of the process may recover: during a restore the replaced file is still the way back.
let recovered = false;

/** Store calls run shared; a restore runs exclusive, so none is midway through the file it swaps. */
export const historyGate = createGate();

/** Opens the history database once; later callers share the result, and a failed open is retried by the next caller. */
export function createDatabase(): Promise<HistoryDatabase> {
  opened ??= (async () => {
    // A restore that was killed between its two renames leaves no live file; put the old one back before opening.
    if (!recovered) {
      recoverInterruptedReplace(createDatabaseFiles());
      recovered = true;
    }
    return openHistory({
      keyState,
      getDatabaseKeyHex,
      // expo-sqlite's default directory is `SQLite` under the document directory.
      databaseExists: () => new File(Paths.document, "SQLite", LIVE_DB).exists,
      openDriver: (keyHex) => createExpoSqliteDriver({ name: LIVE_DB, keyHex }),
      migrate,
      isKeyLostError: (e) => e instanceof KeyLostError,
    });
  })().catch((e) => {
    opened = undefined;
    throw e;
  });
  return opened;
}

/** Closes the open database and forgets it; the next `createDatabase` opens from the file. */
export async function closeDatabase(): Promise<void> {
  const pending = opened;
  opened = undefined;
  const history = await pending?.catch(() => undefined);
  if (history?.kind === "ready") await history.db.close();
}
