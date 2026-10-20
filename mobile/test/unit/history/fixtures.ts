import type { Activity, RouteRecord } from "../../../src/history/types.js";

export function activity(over: Partial<Activity> = {}): Activity {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    travelMode: "walk",
    startedAt: "2026-03-01T10:00:00Z",
    endedAt: "2026-03-01T11:00:00Z",
    stats: { durationS: 3600, distanceM: 4200, steps: 5000 },
    gpx: "<gpx/>",
    track: [
      { t: 0, lat: 48.1, lon: 11.5, accuracy: 5 },
      { t: 3, lat: 48.1001, lon: 11.5001, heartRate: 90 },
    ],
    receivedAt: "2026-03-01T11:05:00Z",
    encoderVersion: "enc-1",
    ...over,
  };
}

export function route(over: Partial<RouteRecord> = {}): RouteRecord {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-03-01T09:00:00Z",
    mode: "loop",
    travelMode: "walk",
    targetDistanceM: 5000,
    waypoints: [
      { lat: 48.1, lng: 11.5 },
      { lat: 48.11, lng: 11.51 },
    ],
    coords: [
      [11.5, 48.1, 520],
      [11.51, 48.11],
    ],
    stats: { distanceM: 5100, seconds: null, ascentM: null, descentM: null },
    gpx: "<gpx/>",
    ...over,
  };
}
