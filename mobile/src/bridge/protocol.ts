import { z } from "zod";

export const ORIGIN = "https://crossfog.madera.codes/";

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const shortName = z.string().min(1).max(255);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
// Unpadded or ragged input would make the decoded size depend on the decoder, so the byte cap below could not be exact.
const base64Data = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

function base64Bytes(s: string): number {
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

// Shared so the three chunk schemas (exportBinary, chunk, track) cannot disagree on the index and total bounds.
const chunkIndex = z.number().int().min(0);
const chunkTotal = z.number().int().min(1);
const indexBelowTotal = (c: { index: number; total: number }) => c.index < c.total;
const INDEX_BELOW_TOTAL = "index must be less than total";

// The page's f2m_* settings as JSON; src/backup/settings.ts checks the content, this bounds the message.
const settingsJson = z.string().max(16_384);

const EXPORT_CHUNK_BYTES = 1_048_576;
// exportId and tileFileName become path segments under the cache.
const exportId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const tileFileName = z.string().regex(/^[a-z0-9]{1,32}$/);
// 0xffff in a zip's entry count means "see the ZIP64 record", so a zip without ZIP64 holds one fewer.
const EXPORT_MAX_FILES = 65_534;
// 1024 chunks of 1 MiB per file: far above any Sync tile.
const EXPORT_MAX_CHUNKS = 1024;
export const TRACK_CHUNK_POINTS = 2000;
// Bounds on a route, far above what a planned route needs; they keep one message from exhausting memory. The coordinate
// cap also applies to the followed route the phone sends with a track.
const ROUTE_MAX_POINTS = 100_000;
const ROUTE_MAX_WAYPOINTS = 500;
const ROUTE_MAX_GPX_CHARS = 10_000_000;

const uuid = z.uuid();
const travelMode = z.string().min(1).max(32);
const nonNegative = z.number().min(0);
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

const routeCoords = z
  .array(z.tuple([lon, lat, z.number().optional()]))
  .min(2)
  .max(ROUTE_MAX_POINTS);

// `seconds` is null when the travel mode has no time model (app/src/estimates.js); `ascentM` and
// `descentM` are null when no elevation arrived (app/src/routeLocal.js). The schema accepts them so
// such a route is sent rather than rejected.
const routeRecord = z.object({
  id: uuid,
  createdAt: isoDate,
  mode: z.enum(["loop", "p2p"]),
  travelMode,
  targetDistanceM: nonNegative.optional(),
  waypoints: z
    .array(z.object({ lat, lng: lon }))
    .min(2)
    .max(ROUTE_MAX_WAYPOINTS),
  coords: routeCoords,
  stats: z.object({
    distanceM: nonNegative,
    seconds: nonNegative.nullable(),
    ascentM: nonNegative.nullable(),
    descentM: nonNegative.nullable(),
  }),
  gpx: z.string().max(ROUTE_MAX_GPX_CHARS),
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
      exportId,
      name: tileFileName,
      index: chunkIndex,
      total: chunkTotal.max(EXPORT_MAX_CHUNKS),
      files: z.number().int().min(1).max(EXPORT_MAX_FILES),
      data: base64Data
        .max(Math.ceil(EXPORT_CHUNK_BYTES / 3) * 4)
        .refine((s) => base64Bytes(s) <= EXPORT_CHUNK_BYTES, "chunk is over 1 MiB"),
    })
    .refine(indexBelowTotal, INDEX_BELOW_TOTAL),
  z.object({ v: z.literal(1), type: z.literal("backup") }),
  z.object({ v: z.literal(1), type: z.literal("restore") }),
  z.object({ v: z.literal(1), type: z.literal("settings"), json: settingsJson }),
  z.object({ v: z.literal(1), type: z.literal("settingsApplied") }),
  // Only the e2e page sends it and only a debug app acts on it; the schema is harmless in release.
  z.object({ v: z.literal(1), type: z.literal("devAddActivity") }),
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
      index: chunkIndex,
      total: chunkTotal,
      data: base64Data,
    })
    .refine(indexBelowTotal, INDEX_BELOW_TOTAL),
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
  z.object({ v: z.literal(1), type: z.literal("needSettings") }),
  z.object({ v: z.literal(1), type: z.literal("applySettings"), json: settingsJson }),
  // The answer to a needTrack for an activity that is gone or cannot be read, so the detail stops waiting.
  z.object({
    v: z.literal(1),
    type: z.literal("trackUnavailable"),
    activityId: uuid,
    reason: z.enum(["notFound", "readFailed"]),
  }),
  z.object({ v: z.literal(1), type: z.literal("activities"), items: z.array(activitySummary) }),
  // Activities the watch handed over that stay staged because the phone cannot read them.
  z.object({
    v: z.literal(1),
    type: z.literal("unreadableActivities"),
    count: z.number().int().min(0),
  }),
  z
    .object({
      v: z.literal(1),
      type: z.literal("track"),
      activityId: uuid,
      index: chunkIndex,
      total: chunkTotal,
      points: z.array(trackPoint).max(TRACK_CHUNK_POINTS),
      // The route the activity followed; only the first chunk carries it.
      route: z.object({ coords: routeCoords }).optional(),
    })
    .refine(indexBelowTotal, INDEX_BELOW_TOTAL),
]);

export type WebToNative = z.infer<typeof webToNativeSchema>;
export type NativeToWeb = z.infer<typeof nativeToWebSchema>;
export type ChunkMessage = Extract<NativeToWeb, { type: "chunk" }>;
export type RouteRecord = z.infer<typeof routeRecord>;
export type ActivitySummary = z.infer<typeof activitySummary>;
export type TrackPoint = z.infer<typeof trackPoint>;
export type ExportChunk = Omit<Extract<WebToNative, { type: "exportBinary" }>, "v" | "type">;

export function encode(msg: WebToNative | NativeToWeb): string {
  return JSON.stringify(msg);
}

export interface DroppedMessage {
  /** The message's `type` when the app knows it, else null: an unknown one is any text the page wrote. */
  type: WebToNative["type"] | null;
  /** Where it broke the schema, as dotted key paths; never a value. */
  paths: string[];
  /** A dropped sendRoute's route id, when that id is itself valid, so the page can hear it failed. */
  routeId: string | null;
}

export type WebToNativeParse = { ok: true; msg: WebToNative } | { ok: false; drop: DroppedMessage };

const MAX_DROP_PATHS = 10;
const NOTHING_TO_NAME: DroppedMessage = { type: null, paths: [], routeId: null };

function issuePaths(issues: readonly z.core.$ZodIssue[]): string[] {
  const paths = issues.map((i) => (i.path.length > 0 ? i.path.map(String).join(".") : "(message)"));
  return [...new Set(paths)].slice(0, MAX_DROP_PATHS);
}

const namesType = (issues: readonly z.core.$ZodIssue[]) => issues.some((i) => i.path[0] === "type");

// Zod hands back the issues of the one branch that got past its literals, or else an invalid_union
// with an issue list per branch: then a branch whose `type` matched is the message's own, and the one
// with the fewest issues is the closest it came, as one type can have several branches.
function describeDrop(data: unknown, error: z.ZodError): DroppedMessage {
  if (typeof data !== "object" || data === null) return { ...NOTHING_TO_NAME };
  let own: readonly z.core.$ZodIssue[] | null = null;
  const [first] = error.issues;
  if (error.issues.length === 1 && first?.code === "invalid_union" && first.path.length === 0) {
    for (const branch of first.errors) {
      if (namesType(branch)) continue;
      if (own === null || branch.length < own.length) own = branch;
    }
  } else if (!namesType(error.issues)) {
    own = error.issues;
  }
  if (own === null) return { ...NOTHING_TO_NAME };
  const obj = data as { type: WebToNative["type"]; route?: unknown };
  const route = obj.type === "sendRoute" ? obj.route : null;
  const id =
    typeof route === "object" && route !== null
      ? uuid.safeParse((route as { id?: unknown }).id)
      : null;
  return { type: obj.type, paths: issuePaths(own), routeId: id?.success ? id.data : null };
}

export function inspectWebToNative(raw: string): WebToNativeParse {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, drop: { ...NOTHING_TO_NAME } };
  }
  const result = webToNativeSchema.safeParse(data);
  return result.success
    ? { ok: true, msg: result.data }
    : { ok: false, drop: describeDrop(data, result.error) };
}

export function parseWebToNative(raw: string): WebToNative | null {
  const result = inspectWebToNative(raw);
  return result.ok ? result.msg : null;
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
