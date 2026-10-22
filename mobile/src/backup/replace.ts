import type { AttachedBackup, SqlDriver } from "../db/driver.js";

export const LIVE_DB = "crossfog.db";
export const RESTORING_DB = "crossfog.restoring.db";
export const REPLACED_DB = "crossfog.replaced.db";

/** The SQLite directory, by file name. A database may have `-wal` and `-shm` sidecars next to it. */
export interface DatabaseFiles {
  pathOf(name: string): string;
  exists(name: string): boolean;
  remove(name: string): void;
  move(from: string, to: string): void;
}

const SIDECARS = ["-wal", "-shm"];

function removeWithSidecars(files: DatabaseFiles, name: string): void {
  files.remove(name);
  for (const s of SIDECARS) files.remove(name + s);
}

/** Puts back what an interrupted swap took away: a missing live file with the replaced one still beside it. */
export function recoverInterruptedReplace(files: DatabaseFiles): void {
  if (!files.exists(LIVE_DB) && files.exists(REPLACED_DB)) {
    files.move(REPLACED_DB, LIVE_DB);
  }
  removeWithSidecars(files, REPLACED_DB);
  removeWithSidecars(files, RESTORING_DB);
}

export interface ReplaceDeps {
  files: DatabaseFiles;
  /** Nothing else touches the history database while `fn` runs. */
  exclusive<R>(fn: () => Promise<R>): Promise<R>;
  /** Closes the open database, if any, and forgets it so the next open starts from the file. */
  closeLive(): Promise<void>;
  /** Opens and migrates the database at `LIVE_DB`; rejects when it cannot be used. */
  reopen(): Promise<void>;
  /** The device key as hex; rejects with the key-lost error when it cannot be read. */
  databaseKeyHex(): Promise<string>;
  /** Replaces a lost device key with a new one. */
  mintDatabaseKeyHex(): Promise<string>;
  isKeyLost(e: unknown): boolean;
  /** Opens a database file in the SQLite directory with the device key. */
  openFile(name: string, keyHex: string): Promise<SqlDriver>;
}

async function count(db: { all<T>(sql: string): Promise<T[]> }, table: string): Promise<number> {
  const [row] = await db.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

/**
 * Makes the opened backup the history database: a new file keyed with the device key, checked
 * against the backup, then swapped in. The old file is kept until the new one opens, so a failure
 * before the swap, or when the new file does not open, leaves the phone as it was; one during the
 * swap itself is undone by `recoverInterruptedReplace` at the next start.
 */
export function createDatabaseReplacer(
  deps: ReplaceDeps,
): (backup: AttachedBackup) => Promise<void> {
  const { files } = deps;

  async function deviceKey(): Promise<string> {
    try {
      return await deps.databaseKeyHex();
    } catch (e) {
      // A lost key means the current file cannot be read by anyone, so a new key costs nothing more.
      if (deps.isKeyLost(e)) return deps.mintDatabaseKeyHex();
      throw e;
    }
  }

  async function build(backup: AttachedBackup, keyHex: string): Promise<void> {
    removeWithSidecars(files, RESTORING_DB);
    await backup.exportTo(files.pathOf(RESTORING_DB), `x'${keyHex}'`);
    const built = await deps.openFile(RESTORING_DB, keyHex);
    try {
      const [{ user_version: version } = { user_version: -1 }] = await built.all<{
        user_version: number;
      }>("PRAGMA user_version");
      const [{ user_version: expected } = { user_version: -2 }] = await backup.all<{
        user_version: number;
      }>("PRAGMA backup.user_version");
      const same =
        version === expected &&
        (await count(built, "activities")) === (await count(backup, "backup.activities")) &&
        (await count(built, "routes")) === (await count(backup, "backup.routes"));
      if (!same) throw new Error("the restored database does not match the backup");
      // Blobs hold the import and the settings only inside a backup; the live database keeps none.
      await built.run("DELETE FROM blobs");
    } finally {
      await built.close();
    }
    // The delete may have left a journal behind; a file moved without it would lose the change.
    for (const s of SIDECARS)
      if (files.exists(RESTORING_DB + s)) throw new Error("journal left behind");
  }

  function swap(): void {
    removeWithSidecars(files, REPLACED_DB);
    if (files.exists(LIVE_DB)) files.move(LIVE_DB, REPLACED_DB);
    for (const s of SIDECARS) files.remove(LIVE_DB + s);
    files.move(RESTORING_DB, LIVE_DB);
  }

  function rollback(): void {
    removeWithSidecars(files, LIVE_DB);
    if (files.exists(REPLACED_DB)) files.move(REPLACED_DB, LIVE_DB);
  }

  return (backup) =>
    deps.exclusive(async () => {
      await deps.closeLive();
      try {
        const keyHex = await deviceKey();
        await build(backup, keyHex);
      } catch (e) {
        removeWithSidecars(files, RESTORING_DB);
        await deps.reopen().catch(() => undefined);
        throw e;
      }
      swap();
      try {
        await deps.reopen();
      } catch (e) {
        rollback();
        await deps.reopen().catch(() => undefined);
        throw e;
      }
      removeWithSidecars(files, REPLACED_DB);
    });
}
