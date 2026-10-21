import type { SqlDriver } from "./driver.js";

export type HistoryDatabase = { kind: "ready"; db: SqlDriver } | { kind: "keyLost" };

export interface OpenHistoryDeps {
  keyState(): Promise<"fresh" | "existing" | "lost">;
  getDatabaseKeyHex(): Promise<string>;
  /** Whether a database file is already on disk. */
  databaseExists(): boolean;
  openDriver(keyHex: string): Promise<SqlDriver>;
  migrate(db: SqlDriver): Promise<number>;
  isKeyLostError(e: unknown): boolean;
}

// A missing key next to an existing database must never fall through to creating an empty one:
// the owner would see a blank history and could overwrite what a backup can still restore.
export async function openHistory(deps: OpenHistoryDeps): Promise<HistoryDatabase> {
  const state = await deps.keyState();
  if (state === "lost" || (state === "fresh" && deps.databaseExists())) return { kind: "keyLost" };

  let keyHex: string;
  try {
    keyHex = await deps.getDatabaseKeyHex();
  } catch (e) {
    if (deps.isKeyLostError(e)) return { kind: "keyLost" };
    throw e;
  }
  const db = await deps.openDriver(keyHex);
  try {
    await deps.migrate(db);
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
  return { kind: "ready", db };
}
