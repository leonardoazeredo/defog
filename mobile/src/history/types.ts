import type { ActivitySummary, RouteRecord, TrackPoint } from "../bridge/protocol.js";

export type { ActivitySummary, RouteRecord };

export interface Activity extends ActivitySummary {
  /** The file as the watch's encoder wrote it; the track is rebuildable from it. */
  gpx: string;
  track: TrackPoint[];
  receivedAt: string;
  encoderVersion: string;
}

export type ActivityDetail = Omit<Activity, "gpx">;

export type StoredRoute = RouteRecord & { sentAt?: string };

/** What a list shows; the geometry and the file stay behind `get`. */
export type RouteSummary = Omit<StoredRoute, "waypoints" | "coords" | "gpx">;

export interface ActivityStore {
  /** Idempotent by id: a known id changes nothing and reports `stored: false`. */
  add(activity: Activity): Promise<{ stored: boolean }>;
  list(): Promise<ActivitySummary[]>;
  /** Everything but the GPX, so a bad GPX blob cannot hide a track that is fine. */
  get(id: string): Promise<ActivityDetail | null>;
  /** Inflates the GPX text on demand; rejects when the stored blob cannot be inflated. */
  gpx(id: string): Promise<string | null>;
  delete(id: string): Promise<boolean>;
}

export interface RouteStore {
  /** Replaces a route saved under the same id, `sentAt` included: the edited route is not the one the watch has. */
  save(route: RouteRecord): Promise<void>;
  get(id: string): Promise<StoredRoute | null>;
  list(): Promise<RouteSummary[]>;
  /** Throws for an unknown id, so a lost route is not mistaken for a delivered one. */
  markSent(id: string): Promise<void>;
}
