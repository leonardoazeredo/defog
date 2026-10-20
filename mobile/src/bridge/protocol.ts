import { z } from "zod";

export const ORIGIN = "https://crossfog.madera.codes/";

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const shortName = z.string().min(1).max(255);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
const base64Data = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

const EXPORT_CHUNK_BYTES = 1_048_576;
const TRACK_CHUNK_POINTS = 2000;

const uuid = z.uuid();
const travelMode = z.string().min(1).max(32);
const nonNegative = z.number().min(0);
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

// `seconds` is null when the travel mode has no time model (app/src/estimates.js); `ascentM` and
// `descentM` are null when no elevation arrived (app/src/routeLocal.js). The schema accepts them so
// such a route is sent rather than rejected.
const routeRecord = z.object({
  id: uuid,
  createdAt: isoDate,
  mode: z.enum(["loop", "p2p"]),
  travelMode,
  targetDistanceM: nonNegative.optional(),
  waypoints: z.array(z.object({ lat, lng: lon })).min(2),
  coords: z.array(z.tuple([lon, lat, z.number().optional()])).min(2),
  stats: z.object({
    distanceM: nonNegative,
    seconds: nonNegative.nullable(),
    ascentM: nonNegative.nullable(),
    descentM: nonNegative.nullable(),
  }),
  gpx: z.string(),
});

const activitySummary = z.object({
  id: uuid,
  travelMode,
  startedAt: isoDate,
  endedAt: isoDate,
  routeId: uuid.optional(),
  stats: z.object({
    durationS: nonNegative,
    distanceM: nonNegative,
    paceSPerKm: nonNegative.optional(),
    steps: nonNegative.optional(),
    calories: nonNegative.optional(),
    heartRateAvg: nonNegative.optional(),
    heartRateMax: nonNegative.optional(),
  }),
});

const trackPoint = z.object({
  t: nonNegative,
  lat,
  lon,
  accuracy: nonNegative.optional(),
  elevation: z.number().optional(),
  speed: nonNegative.optional(),
  heartRate: nonNegative.optional(),
  steps: nonNegative.optional(),
  cadence: nonNegative.optional(),
});

const webToNativeSchema = z.union([
  z.object({ v: z.literal(1), type: z.literal("ready") }),
  z.object({ v: z.literal(1), type: z.literal("pickBackup") }),
  z.object({ v: z.literal(1), type: z.literal("needBytes"), fingerprint }),
  z.object({
    v: z.literal(1),
    type: z.literal("loaded"),
    fingerprint,
    ok: z.literal(true),
    tiles: z.number().int().min(1),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal("loaded"),
    fingerprint,
    ok: z.literal(false),
    reason: z.enum(["unzip", "noTiles", "memory", "checksum", "unknown"]),
  }),
  z.object({ v: z.literal(1), type: z.literal("clearSavedFog") }),
  z.object({ v: z.literal(1), type: z.literal("retryReload") }),
  z.object({
    v: z.literal(1),
    type: z.literal("export"),
    filename: shortName,
    mime: z.string().min(1).max(100),
    text: z.string(),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal("openExternal"),
    url: z.string().regex(/^https?:\/\//),
  }),
  z.object({ v: z.literal(1), type: z.literal("openAbout") }),
  z.object({ v: z.literal(1), type: z.literal("back:result"), handled: z.boolean() }),
  z.object({ v: z.literal(1), type: z.literal("sendRoute"), route: routeRecord }),
  z.object({ v: z.literal(1), type: z.literal("needTrack"), activityId: uuid }),
  z.object({ v: z.literal(1), type: z.literal("deleteActivity"), activityId: uuid }),
  z
    .object({
      v: z.literal(1),
      type: z.literal("exportBinary"),
      exportId: z.string().min(1).max(64),
      name: shortName,
      index: z.number().int().min(0),
      total: z.number().int().min(1),
      data: base64Data.max(Math.ceil(EXPORT_CHUNK_BYTES / 3) * 4),
    })
    .refine((c) => c.index < c.total, "index must be less than total"),
  z.object({ v: z.literal(1), type: z.literal("backup") }),
  z.object({ v: z.literal(1), type: z.literal("restore") }),
]);

const nativeToWebSchema = z.union([
  z.object({
    v: z.literal(1),
    type: z.literal("reload"),
    fingerprint,
    name: shortName,
    savedAt: isoDate,
    size: z.number().int().min(0),
    role: z.enum(["current", "pending"]),
  }),
  z
    .object({
      v: z.literal(1),
      type: z.literal("chunk"),
      fingerprint,
      index: z.number().int().min(0),
      total: z.number().int().min(1),
      data: base64Data,
    })
    .refine((c) => c.index < c.total, "index must be less than total"),
  z.object({ v: z.literal(1), type: z.literal("none") }),
  z.object({ v: z.literal(1), type: z.literal("reloadSuspended"), savedAt: isoDate }),
  z.object({
    v: z.literal(1),
    type: z.literal("notice"),
    text: z.string().min(1).max(500),
  }),
  z.object({ v: z.literal(1), type: z.literal("back") }),
  z.object({
    v: z.literal(1),
    type: z.literal("routeStatus"),
    routeId: uuid,
    state: z.enum(["waiting", "onWatch", "failed"]),
    why: z.string().max(500).optional(),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal("linkStatus"),
    paired: z.boolean(),
    reachable: z.boolean(),
  }),
  z.object({ v: z.literal(1), type: z.literal("activities"), items: z.array(activitySummary) }),
  z
    .object({
      v: z.literal(1),
      type: z.literal("track"),
      activityId: uuid,
      index: z.number().int().min(0),
      total: z.number().int().min(1),
      points: z.array(trackPoint).max(TRACK_CHUNK_POINTS),
    })
    .refine((c) => c.index < c.total, "index must be less than total"),
]);

export type WebToNative = z.infer<typeof webToNativeSchema>;
export type NativeToWeb = z.infer<typeof nativeToWebSchema>;
export type ChunkMessage = Extract<NativeToWeb, { type: "chunk" }>;
export type RouteRecord = z.infer<typeof routeRecord>;
export type ExportChunk = Omit<Extract<WebToNative, { type: "exportBinary" }>, "v" | "type">;

export function encode(msg: WebToNative | NativeToWeb): string {
  return JSON.stringify(msg);
}

export function parseWebToNative(raw: string): WebToNative | null {
  try {
    const result = webToNativeSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseNativeToWeb(raw: string): NativeToWeb | null {
  try {
    const result = nativeToWebSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Android WebView reports the baseUrl without its trailing slash in onMessage events.
export function isTrustedSource(url: string): boolean {
  return (
    url === ORIGIN ||
    url === ORIGIN.slice(0, -1) ||
    (url.startsWith(ORIGIN) && (url[ORIGIN.length] === "#" || url[ORIGIN.length] === "?"))
  );
}
