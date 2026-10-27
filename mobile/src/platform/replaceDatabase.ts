import { getRandomBytes } from "expo-crypto";
import { createDatabaseReplacer } from "../backup/replace.js";
import { toHex } from "../bridge/hex.js";
import { createDatabaseFiles } from "./backupPlatform.js";
import { closeDatabase, createDatabase, historyGate } from "./database.js";
import { createExpoSqliteDriver } from "./expoSqliteDriver.js";
import {
  getDatabaseKeyHex,
  KeyLostError,
  keyState,
  replaceLostDatabaseKeyHex,
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
  newDatabaseKeyHex() {
    const bytes = getRandomBytes(32);
    try {
      return toHex(bytes);
    } finally {
      bytes.fill(0);
    }
  },
  replaceLostDatabaseKey: replaceLostDatabaseKeyHex,
  isKeyLost: (e) => e instanceof KeyLostError,
  openFile: (name, keyHex) => createExpoSqliteDriver({ name, keyHex }),
});
