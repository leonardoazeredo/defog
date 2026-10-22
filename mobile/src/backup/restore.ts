import { type AttachedBackup, NotADatabaseError, type OpenBackup } from "../db/driver.js";
import type { FogStore, SourceFile } from "../fog/store.js";
import { BLOB_IMPORT, BLOB_SETTINGS, classifyBackupFile, isBackupDatabase } from "./format.js";
import { parseSettings } from "./settings.js";
import type { PassphraseAnswer, Scratch } from "./types.js";

/** `fogNotReplaced`: the history is the backup's but the saved fog import could not be swapped. */
export type RestoreResult =
  | "restored"
  | "fogNotReplaced"
  | "cancelled"
  | "wrongPassphrase"
  | "notABackup";

export interface RestoreDeps {
  pickFile(): Promise<SourceFile | null>;
  /** Streams the picked document into `destPath`; `head` is the file's first 16 bytes as hex. */
  copyFromUri(uri: string, destPath: string): Promise<{ size: number; head: string }>;
  scratch: Scratch;
  openBackup: OpenBackup;
  /** Makes the opened backup the history database. */
  replaceDatabase(backup: AttachedBackup): Promise<void>;
  fogStore: FogStore;
  /** "Replace everything on this phone with this backup?" */
  confirm(): Promise<boolean>;
  askPassphrase(): Promise<PassphraseAnswer | null>;
  settings: { apply(json: string): Promise<void> };
}

interface BlobRow {
  name: string;
  bytes: Uint8Array;
}

async function blob(backup: AttachedBackup, kind: string): Promise<BlobRow | null> {
  const [row] = await backup.all<BlobRow>("SELECT name, bytes FROM backup.blobs WHERE kind = ?", [
    kind,
  ]);
  return row ?? null;
}

export function createRestoreFlow(deps: RestoreDeps): { run(): Promise<RestoreResult> } {
  const { scratch, fogStore } = deps;

  // The import is staged as a pending copy before the database is replaced, so a failed replace can discard it.
  async function stageImport(backup: AttachedBackup, tmpZip: string): Promise<boolean> {
    const zip = await blob(backup, BLOB_IMPORT);
    if (zip === null) return false;
    await scratch.writeBytes(tmpZip, new Uint8Array(zip.bytes));
    await fogStore.beginImport({ uri: scratch.uri(tmpZip), name: zip.name }, "picker");
    return true;
  }

  return {
    async run() {
      const picked = await deps.pickFile();
      if (picked === null) return "cancelled";

      const tmpDb = scratch.path("restore-backup.db");
      const tmpZip = scratch.path("restore-import.zip");
      let backup: AttachedBackup | null = null;
      try {
        const { size, head } = await deps.copyFromUri(picked.uri, tmpDb);
        const kind = classifyBackupFile(head, size);
        if (kind === "notABackup") return "notABackup";

        let key: string | null = null;
        if (kind === "maybeEncrypted") {
          const answer = await deps.askPassphrase();
          if (answer === null) return "cancelled";
          if (answer.kind === "passphrase") key = answer.passphrase;
        }
        try {
          backup = await deps.openBackup(tmpDb, key);
        } catch (e) {
          if (!(e instanceof NotADatabaseError)) throw e;
          // SQLite cannot tell a wrong passphrase from a file that is no database; only a file that
          // looked encrypted can be blamed on the passphrase.
          return kind === "maybeEncrypted" ? "wrongPassphrase" : "notABackup";
        }
        if (!(await isBackupDatabase(backup))) return "notABackup";
        if (!(await deps.confirm())) return "cancelled";

        const settingsRow = await blob(backup, BLOB_SETTINGS);
        const settings =
          settingsRow === null ? null : new TextDecoder().decode(new Uint8Array(settingsRow.bytes));
        let hasImport: boolean;
        try {
          hasImport = await stageImport(backup, tmpZip);
          await deps.replaceDatabase(backup);
        } catch (e) {
          await fogStore.discardPending().catch(() => undefined);
          throw e;
        }
        try {
          if (hasImport) await fogStore.promotePending();
          else await fogStore.clear();
        } catch {
          // The history is already the backup's; the page must reload even though the fog could not follow.
          return "fogNotReplaced";
        }

        if (settings !== null && parseSettings(settings) !== null) {
          // The history and the fog are already back; a page that does not answer only keeps its old settings.
          await deps.settings.apply(settings).catch(() => undefined);
        }
        return "restored";
      } finally {
        // Cleanup runs after the outcome is known and must not turn it into a failure.
        await backup?.close().catch(() => undefined);
        await scratch.remove(tmpDb).catch(() => undefined);
        await scratch.remove(tmpZip).catch(() => undefined);
      }
    },
  };
}
