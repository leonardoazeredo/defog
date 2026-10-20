import type { SqlDriver } from "../db/driver.js";
import type { RouteStore, RouteSummary, StoredRoute } from "./types.js";

interface Row {
  id: string;
  created_at: string;
  mode: StoredRoute["mode"];
  travel_mode: string;
  target_distance_m: number | null;
  waypoints_json: string;
  coords_json: string;
  stats_json: string;
  gpx: string;
  sent_at: string | null;
}

function toSummary(r: Omit<Row, "waypoints_json" | "coords_json" | "gpx">): RouteSummary {
  return {
    id: r.id,
    createdAt: r.created_at,
    mode: r.mode,
    travelMode: r.travel_mode,
    ...(r.target_distance_m === null ? {} : { targetDistanceM: r.target_distance_m }),
    stats: JSON.parse(r.stats_json),
    ...(r.sent_at === null ? {} : { sentAt: r.sent_at }),
  };
}

export function createRouteStore(db: SqlDriver, deps: { now?: () => Date } = {}): RouteStore {
  const now = deps.now ?? (() => new Date());
  return {
    async save(r) {
      await db.run(
        `INSERT OR REPLACE INTO routes
           (id, created_at, mode, travel_mode, target_distance_m, waypoints_json, coords_json, stats_json, gpx, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          r.id,
          r.createdAt,
          r.mode,
          r.travelMode,
          r.targetDistanceM ?? null,
          JSON.stringify(r.waypoints),
          JSON.stringify(r.coords),
          JSON.stringify(r.stats),
          r.gpx,
        ],
      );
    },

    async get(id) {
      const [r] = await db.all<Row>("SELECT * FROM routes WHERE id = ?", [id]);
      if (!r) return null;
      return {
        ...toSummary(r),
        waypoints: JSON.parse(r.waypoints_json),
        coords: JSON.parse(r.coords_json),
        gpx: r.gpx,
      };
    },

    async list() {
      const rows = await db.all<Omit<Row, "waypoints_json" | "coords_json" | "gpx">>(
        "SELECT id, created_at, mode, travel_mode, target_distance_m, stats_json, sent_at FROM routes ORDER BY julianday(created_at) DESC, id DESC",
      );
      return rows.map(toSummary);
    },

    async markSent(id) {
      const { changes } = await db.run("UPDATE routes SET sent_at = ? WHERE id = ?", [
        now().toISOString(),
        id,
      ]);
      if (changes === 0) throw new Error("unknown route");
    },
  };
}
