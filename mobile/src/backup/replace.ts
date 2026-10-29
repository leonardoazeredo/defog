import type { AttachedBackup, SqlDriver } from "../db/driver.js";
import type { DatabaseKeyHex } from "../db/keyHex.js";
import { keyIsLostOrUnreadable } from "../db/keyState.js";
import type { KeyState } from "../platform/watchLinkModule.js";

// The native DATABASE_FILES (Keys.kt) lists LIVE_DB and REPLACED_DB. RESTORING_DB is not in it: a
// restore deletes and rebuilds it, so no state worth guarding ever lives there.
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

/**
 * Puts back the old file when a swap left no live one, and removes a staged RESTORING_DB. Safe at
 * any time: swap() runs its moves with no await between them, so a running process never sees that
 * state; only a killed one leaves it.
 * The replaced copy is not deleted here: with both files present the new one is unproven.
 */
export function recoverInterruptedReplace(files: DatabaseFiles): void {
  if (!files.exists(LIVE_DB) && files.exists(REPLACED_DB)) {
    files.move(REPLACED_DB, LIVE_DB);
  }
  removeWithSidecars(files, RESTORING_DB);
}

/** Makes the old file live again, discarding the live one; otherwise it only removes a staged RESTORING_DB. */
export function putBackReplacedCopy(files: DatabaseFiles): void {
  if (files.exists(REPLACED_DB)) {
    removeWithSidecars(files, LIVE_DB);
    files.move(REPLACED_DB, LIVE_DB);
  }
  removeWithSidecars(files, RESTORING_DB);
}

/** Drops the old file once the new one has opened and migrated. */
export function discardReplacedCopy(files: DatabaseFiles): void {
  removeWithSidecars(files, REPLACED_DB);
}

export interface ReplaceDeps {
  files: DatabaseFiles;
  /** Nothing else touches the history database while `fn` runs. */
  exclusive<R>(fn: () => Promise<R>): Promise<R>;
  /** Closes the open database, if any, and forgets it so the next open starts from the file. */
  closeLive(): Promise<void>;
  /** Opens and migrates the database at `LIVE_DB`; rejects when it cannot be used. */
  reopen(): Promise<void>;
  /**
   * The device key, as hex; rejects with the key-lost error when it cannot be read (only `keyState`
   * says whether it may be replaced), or with the key-unavailable error when the read failed otherwise.
   */
  databaseKeyHex(): Promise<DatabaseKeyHex>;
  /** The native key state; only `lost` and `unreadable` let `replaceLostDatabaseKey` keep a new key. */
  keyState(): Promise<KeyState>;
  /** A new random device key as hex; nothing is kept until `replaceLostDatabaseKey`. */
  newDatabaseKeyHex(): DatabaseKeyHex;
  /** Keeps `keyHex` as the device key in place of a lost or unreadable one. */
  replaceLostDatabaseKey(keyHex: DatabaseKeyHex): Promise<void>;
  isKeyLost(e: unknown): boolean;
  /** Opens a database file in the SQLite directory with the device key. */
  openFile(name: string, keyHex: DatabaseKeyHex): Promise<SqlDriver>;
}

/** The key a restore builds with: the device's own, or a new one that replaces a lost one after the swap. */
type DeviceKey =
  | { kind: "existing"; hex: DatabaseKeyHex }
  | { kind: "replacement"; hex: DatabaseKeyHex };

async function count(db: { all<T>(sql: string): Promise<T[]> }, table: string): Promise<number> {
  const [row] = await db.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

/**
 * Makes the opened backup the history database: a new file keyed with the device key, checked
 * against the backup, then swapped in. The old file is kept until the new one opens, so a failure
 * before the swap, during it, or when the new file does not open, leaves the phone as it was
 * (except once a lost or unreadable key is replaced, below). A process killed between the two
 * moves in swap() is undone by `recoverInterruptedReplace`; killed after the second, the new file
 * stays live and the next first open decides.
 *
 * When the device key was lost or is unreadable for good, the new file is built with a new key that
 * is kept only after the swap, so a restore that fails before then leaves the old key as well as
 * the old file (a failure inside `replaceLostDatabaseKey` may leave no usable key; the native
 * `Keys` says how it reads). A failure after the key is kept leaves the new file live and drops
 * the old one, which neither key can open, so the next open may still succeed. A process killed
 * after the swap and before the key is kept leaves the key lost or unreadable beside a live file
 * nothing can read, which a second restore replaces.
 */
export function createDatabaseReplacer(
  deps: ReplaceDeps,
): (backup: AttachedBackup) => Promise<void> {
  const { files } = deps;

  async function deviceKey(): Promise<DeviceKey> {
    try {
      return { kind: "existing", hex: await deps.databaseKeyHex() };
    } catch (e) {
      if (!deps.isKeyLost(e)) throw e;
      // Only a key in the native `lost` state (one of alias and key file gone) or `unreadable` state
      // (both there, unwrapping fails for good) is replaced: the current file cannot be read by
      // anyone, so a new key costs nothing more. A key that failed in a way that may pass (`existing`)
      // is not replaced, so a file built for a new one would be thrown away after the swap.
      const state = await deps.keyState().catch(() => {
        throw e;
      });
      if (!keyIsLostOrUnreadable(state)) throw e;
      return { kind: "replacement", hex: deps.newDatabaseKeyHex() };
    }
  }

  async function build(backup: AttachedBackup, keyHex: DatabaseKeyHex): Promise<void> {
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
      // The DELETE only frees the blob pages; without VACUUM the file keeps the import zip in them
      // and stays the backup's size. VACUUM writes a second copy of the file meanwhile, which the
      // restore's space check allows for.
      await built.exec("VACUUM");
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

  // Leaves the live file alone when the swap failed before the old file moved; still removes
  // a staged RESTORING_DB.
  const rollback = () => putBackReplacedCopy(files);

  return (backup) =>
    deps.exclusive(async () => {
      await deps.closeLive();
      let key: DeviceKey;
      try {
        key = await deviceKey();
        await build(backup, key.hex);
      } catch (e) {
        removeWithSidecars(files, RESTORING_DB);
        await deps.reopen().catch(() => undefined);
        throw e;
      }
      let keyKept = false;
      try {
        swap();
        // Kept before reopen, which reads the key from the device.
        if (key.kind === "replacement") {
          await deps.replaceLostDatabaseKey(key.hex);
          keyKept = true;
        }
        await deps.reopen();
      } catch (e) {
        // Neither key opens the old file once the new one is kept, so the new file is the only one
        // worth keeping.
        if (keyKept) discardReplacedCopy(files);
        else rollback();
        await deps.reopen().catch(() => undefined);
        throw e;
      }
      discardReplacedCopy(files);
    });
}
