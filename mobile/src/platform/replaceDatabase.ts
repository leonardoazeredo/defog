import { getRandomBytes } from "expo-crypto";
import { createDatabaseReplacer } from "../backup/replace.js";
import { newDatabaseKeyHex } from "../db/keyHex.js";
import { createDatabaseFiles } from "./backupPlatform.js";
import { closeDatabase, createDatabase, historyGate } from "./database.js";
import { createExpoSqliteDriver } from "./expoSqliteDriver.js";
import {
  getDatabaseKeyHex,
  KeyLostError,
  keyState,
  replaceLostDatabaseKey,
} from "./watchLinkModule.js";

export const replaceDatabase = createDatabaseReplacer({
  files: createDatabaseFiles(),
  exclusive: historyGate.exclusive,
  closeLive: closeDatabase,
  async reopen() {
    const history = await createDatabase();
    if (history.kind !== "ready") throw new Error("history is unavailable");
  },
  databaseKeyHex: getDatabaseKeyHex,
  keyState,
  newDatabaseKeyHex: () => newDatabaseKeyHex(getRandomBytes),
  replaceLostDatabaseKey,
  isKeyLost: (e) => e instanceof KeyLostError,
  openFile: (name, keyHex) => createExpoSqliteDriver({ name, keyHex }),
});
