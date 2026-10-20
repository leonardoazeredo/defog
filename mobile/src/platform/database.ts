import { File, Paths } from "expo-file-system";
import { type HistoryDatabase, openHistory } from "../db/openHistory.js";
import { migrate } from "../db/schema.js";
import { createExpoSqliteDriver } from "./expoSqliteDriver.js";
import { getDatabaseKeyHex, KeyLostError, keyState } from "./watchLinkModule.js";

const DB_NAME = "crossfog.db";

let opened: Promise<HistoryDatabase> | undefined;

/** Opens the history database once; later callers share the result, and a failed open is retried by the next caller. */
export function createDatabase(): Promise<HistoryDatabase> {
  opened ??= openHistory({
    keyState,
    getDatabaseKeyHex,
    // expo-sqlite's default directory is `SQLite` under the document directory.
    databaseExists: () => new File(Paths.document, "SQLite", DB_NAME).exists,
    openDriver: (keyHex) => createExpoSqliteDriver({ name: DB_NAME, keyHex }),
    migrate,
    isKeyLostError: (e) => e instanceof KeyLostError,
  }).catch((e) => {
    opened = undefined;
    throw e;
  });
  return opened;
}
