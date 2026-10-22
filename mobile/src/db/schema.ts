import type { SqlDriver } from "./driver.js";

// Each entry migrates from index to index + 1. Never edit a shipped entry; append a new one.
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE activities (
    id TEXT PRIMARY KEY,
    travel_mode TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    route_id TEXT,
    gpx TEXT NOT NULL,
    track_json TEXT NOT NULL,
    stats_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    encoder_version TEXT NOT NULL
  );
  CREATE TABLE routes (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    travel_mode TEXT NOT NULL,
    target_distance_m REAL,
    waypoints_json TEXT NOT NULL,
    coords_json TEXT NOT NULL,
    stats_json TEXT NOT NULL,
    gpx TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE TABLE blobs (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY (kind, name)
  );`,
];

/** The schema version this build writes; a backup from a higher one is from a newer app. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export async function migrate(db: SqlDriver): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx.all<{ user_version: number }>("PRAGMA user_version");
    const current = row?.user_version ?? 0;
    if (current > MIGRATIONS.length) {
      throw new Error(`database is from a newer app (schema ${current})`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      await tx.exec(MIGRATIONS[v] as string);
    }
    // PRAGMA takes no bound parameters; the value is our own integer.
    await tx.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    return MIGRATIONS.length;
  });
}
