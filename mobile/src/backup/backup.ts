import type { OpenBackup, SqlDriver } from "../db/driver.js";
import type { FileStore } from "../fog/fileStore.js";
import { type FogStore, zipName } from "../fog/store.js";
import {
  BACKUP_MIME,
  BLOB_IMPORT,
  BLOB_SETTINGS,
  backupName,
  SETTINGS_BLOB_NAME,
} from "./format.js";
import { BackupError, type PassphraseAnswer, type Scratch } from "./types.js";

export type BackupResult = { status: "saved"; name: string } | { status: "cancelled" };

export interface BackupDeps {
  /** Runs `fn` on the history database while a restore cannot swap it away. */
  withDb<R>(fn: (db: SqlDriver) => Promise<R>): Promise<R>;
  openBackup: OpenBackup;
  fogStore: FogStore;
  /** The store holding the Fog of World import zip. */
  fs: FileStore;
  scratch: Scratch;
  settings: { request(): Promise<string> };
  askPassphrase(): Promise<PassphraseAnswer | null>;
  /** Warns that anyone who has an unencrypted file can read it; false cancels the backup. */
  confirmUnencrypted(): Promise<boolean>;
  /** Streams the file into a document the user picks; null when the picker was cancelled. */
  saveAs(path: string, name: string, mime: string): Promise<{ name: string } | null>;
  now(): number;
}

// The live database and the export each take about a database's worth of space; the factor also leaves headroom for the import zip, which the check does not count.
const SPACE_FACTOR = 3;

export function createBackupFlow(deps: BackupDeps): { run(): Promise<BackupResult> } {
  const cancelled: BackupResult = { status: "cancelled" };

  async function chooseKey(): Promise<{ key: string | null } | null> {
    const answer = await deps.askPassphrase();
    if (answer === null) return null;
    if (answer.kind === "passphrase") return { key: answer.passphrase };
    return (await deps.confirmUnencrypted()) ? { key: null } : null;
  }

  async function addBlobs(path: string, key: string | null, settings: string): Promise<void> {
    const backup = await deps.openBackup(path, key);
    try {
      // The temporary file is rewritten whole by the export, so a rollback journal here leaves no sidecar to lose.
      await backup.exec("PRAGMA backup.journal_mode = DELETE");
      const meta = await deps.fogStore.current();
      if (meta !== null) {
        const zip = await deps.fs.readBytes(zipName(meta));
        await backup.run("INSERT INTO backup.blobs (kind, name, bytes) VALUES (?, ?, ?)", [
          BLOB_IMPORT,
          meta.name,
          zip,
        ]);
      }
      await backup.run("INSERT INTO backup.blobs (kind, name, bytes) VALUES (?, ?, ?)", [
        BLOB_SETTINGS,
        SETTINGS_BLOB_NAME,
        new TextEncoder().encode(settings),
      ]);
    } finally {
      await backup.close();
    }
  }

  return {
    async run() {
      const choice = await chooseKey();
      if (choice === null) return cancelled;

      let settings: string;
      try {
        settings = await deps.settings.request();
      } catch {
        throw new BackupError("noSettings");
      }
      if ((await deps.scratch.freeBytes()) < SPACE_FACTOR * (await deps.scratch.databaseBytes())) {
        throw new BackupError("noSpace");
      }

      const name = backupName(deps.now());
      const tmp = deps.scratch.path(name);
      await deps.scratch.remove(tmp);
      try {
        await deps.withDb((db) => db.exportTo(tmp, choice.key));
        await addBlobs(tmp, choice.key, settings);
        const saved = await deps.saveAs(tmp, name, BACKUP_MIME);
        return saved === null ? cancelled : { status: "saved", name: saved.name };
      } finally {
        await deps.scratch.remove(tmp);
      }
    },
  };
}
