import type { SqlDriver } from "../db/driver.js";
import type { Activity, ActivityStore, ActivitySummary } from "./types.js";

interface Row {
  id: string;
  travel_mode: string;
  started_at: string;
  ended_at: string;
  route_id: string | null;
  gpx: string;
  track_json: string;
  stats_json: string;
  received_at: string;
  encoder_version: string;
}

const SUMMARY_COLUMNS = "id, travel_mode, started_at, ended_at, route_id, stats_json";

function toSummary(
  r: Pick<Row, "id" | "travel_mode" | "started_at" | "ended_at" | "route_id" | "stats_json">,
): ActivitySummary {
  return {
    id: r.id,
    travelMode: r.travel_mode,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    ...(r.route_id === null ? {} : { routeId: r.route_id }),
    stats: JSON.parse(r.stats_json),
  };
}

export function createActivityStore(db: SqlDriver): ActivityStore {
  return {
    async add(a) {
      const { changes } = await db.run(
        `INSERT OR IGNORE INTO activities
           (id, travel_mode, started_at, ended_at, route_id, gpx, track_json, stats_json, received_at, encoder_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          a.id,
          a.travelMode,
          a.startedAt,
          a.endedAt,
          a.routeId ?? null,
          a.gpx,
          JSON.stringify(a.track),
          JSON.stringify(a.stats),
          a.receivedAt,
          a.encoderVersion,
        ],
      );
      return { stored: changes > 0 };
    },

    async list() {
      // julianday, not the text: ISO strings with and without fractional seconds do not sort as text.
      const rows = await db.all<Row>(
        `SELECT ${SUMMARY_COLUMNS} FROM activities ORDER BY julianday(started_at) DESC, id DESC`,
      );
      return rows.map(toSummary);
    },

    async get(id) {
      const [r] = await db.all<Row>("SELECT * FROM activities WHERE id = ?", [id]);
      if (!r) return null;
      const full: Activity = {
        ...toSummary(r),
        gpx: r.gpx,
        track: JSON.parse(r.track_json),
        receivedAt: r.received_at,
        encoderVersion: r.encoder_version,
      };
      return full;
    },

    async delete(id) {
      const { changes } = await db.run("DELETE FROM activities WHERE id = ?", [id]);
      return changes > 0;
    },
  };
}
