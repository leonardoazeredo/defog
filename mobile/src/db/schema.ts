import { deflateGpx } from "../history/gpxBlob.js";
import type { SqlDriver, SqlTx } from "./driver.js";

type Migration = string | ((tx: SqlTx) => Promise<void>);

// The GPX becomes a deflated BLOB. SQLite cannot change a column's type in place, so the table is
// rebuilt (which also keeps the column NOT NULL, allowed by ADD COLUMN only with a default), and
// the deflate runs in JS, so rows are copied one at a time (one GPX in memory at once). migrate()
// runs every step in one transaction, so a step that stops midway leaves schema 1 whole for the
// next open to migrate; in a killed process SQLite rolls the unfinished transaction back on that
// open. This step writes with deflateGpx, whose format is frozen (see gpxBlob.ts).
async function deflateActivityGpx(tx: SqlTx): Promise<void> {
  await tx.exec(`CREATE TABLE activities_v2 (
    id TEXT PRIMARY KEY,
    travel_mode TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    route_id TEXT,
    gpx_deflated BLOB NOT NULL,
    track_json TEXT NOT NULL,
    stats_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    encoder_version TEXT NOT NULL
  )`);
  const ids = await tx.all<{ id: string }>("SELECT id FROM activities");
  for (const { id } of ids) {
    const [row] = await tx.all<{ gpx: string }>("SELECT gpx FROM activities WHERE id = ?", [id]);
    if (!row) throw new Error("an activity vanished while its GPX was deflated");
    await tx.run(
      `INSERT INTO activities_v2
         SELECT id, travel_mode, started_at, ended_at, route_id, ?, track_json, stats_json,
                received_at, encoder_version
         FROM activities WHERE id = ?`,
      [deflateGpx(row.gpx), id],
    );
  }
  await tx.exec("DROP TABLE activities; ALTER TABLE activities_v2 RENAME TO activities;");
}

// Each entry migrates from index to index + 1. Never edit a shipped entry; append a new one.
const MIGRATIONS: readonly Migration[] = [
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
  deflateActivityGpx,
];

/** The schema version this build writes; a backup from a higher one is from a newer app. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export async function migrate(db: SqlDriver): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx.all<{ user_version: number }>("PRAGMA user_version");
    const current = row?.user_version ?? 0;
    if (current > MIGRATIONS.length) {
      throw new Error(`database is from a newer app (schema ${current}); update the app`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      const step = MIGRATIONS[v] as Migration;
      if (typeof step === "string") await tx.exec(step);
      else await step(tx);
    }
    // PRAGMA takes no bound parameters; the value is our own integer.
    await tx.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    return MIGRATIONS.length;
  });
}
