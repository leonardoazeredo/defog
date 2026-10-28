import type { SqlTx } from "../../src/db/driver.js";

// A frozen copy of schema 1, the first release's, with the GPX as text, so tests can build the
// databases and backups that release left on phones. It never follows MIGRATIONS.
const V1 = `CREATE TABLE activities (
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
  );
  PRAGMA user_version = 1;`;

export interface V1Activity {
  id: string;
  gpx: string;
  startedAt?: string;
}

/**
 * Builds a schema-1 database holding `activities`, each with the GPX stored as text. Columns
 * other than id, gpx and started_at hold fixed values, which schema.test.ts asserts after the migration.
 */
export async function createV1Database(db: SqlTx, activities: V1Activity[] = []): Promise<void> {
  await db.exec(V1);
  for (const a of activities) {
    await db.run(
      `INSERT INTO activities
         (id, travel_mode, started_at, ended_at, route_id, gpx, track_json, stats_json, received_at, encoder_version)
       VALUES (?, 'walk', ?, '2026-03-01T11:00:00Z', NULL, ?, '[{"t":0,"lat":48.1,"lon":11.5}]', '{"durationS":3600}', '2026-03-01T11:05:00Z', 'enc-1')`,
      [a.id, a.startedAt ?? "2026-03-01T10:00:00Z", a.gpx],
    );
  }
}
