import type { ActivitySummary, TrackPoint } from "../bridge/protocol.js";

/** What the watch's summary carries, in the units the activity stats use. */
interface GpxSummary {
  steps?: number;
  calories?: number;
  heartRateAvg?: number;
  heartRateMax?: number;
  durationS?: number;
  distanceM?: number;
}

export interface ParsedGpx {
  points: TrackPoint[];
  summary?: GpxSummary;
  startedAt: string;
  endedAt: string;
  /** Length of the track, not counting the jump across a pause between two segments. */
  trackDistanceM: number;
}

// Messages never carry file content: a track is where the owner walked.
export class GpxError extends Error {
  override name = "GpxError";
}

// GlanceMap writes its own fixed output (TraceGpxEncoder.kt), so this reads that, not arbitrary XML:
// Hermes has no DOMParser and a track can be tens of thousands of points.
// GlanceMap's own elements carry the `gmap:` prefix; the standard GPX ones carry none.
const PREFIXES = ["", "gmap:"] as const;

function unescapeXml(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function elementText(body: string, local: string): string | undefined {
  for (const prefix of PREFIXES) {
    const open = `<${prefix}${local}>`;
    const start = body.indexOf(open);
    if (start < 0) continue;
    const end = body.indexOf(`</${prefix}${local}>`, start + open.length);
    if (end < 0) continue;
    return unescapeXml(body.slice(start + open.length, end)).trim();
  }
  return undefined;
}

// The page's schema rejects a negative figure for every field but elevation, and one rejected summary
// would hide the whole history list; a sentinel such as -1 is read as absent.
function elementNumber(body: string, local: string, signed = false): number | undefined {
  const text = elementText(body, local);
  if (text === undefined || text === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) && (signed || n >= 0) ? n : undefined;
}

function attribute(tag: string, name: string): number | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(tag);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

// Optional properties are left out rather than set to undefined (exactOptionalPropertyTypes). It
// deletes from `o` in place and casts, so `o` must be a fresh literal.
function dropUndefined<R>(o: Record<string, unknown>): R {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o as R;
}

function readPoint(tag: string, body: string): TrackPoint {
  const lat = attribute(tag, "lat");
  const lon = attribute(tag, "lon");
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new GpxError("a track point has no valid position");
  }
  const time = elementText(body, "time");
  const t = time === undefined ? Number.NaN : Date.parse(time);
  if (!Number.isFinite(t) || t < 0) throw new GpxError("a track point has no valid time");
  return dropUndefined<TrackPoint>({
    t,
    lat,
    lon,
    // Reveal (app/src/reveal.js) drops points by effective accuracy, so keep that value; the raw one is the fallback.
    accuracy:
      elementNumber(body, "effectiveAccuracyMeters") ?? elementNumber(body, "accuracyMeters"),
    elevation: elementNumber(body, "ele", true),
    speed: elementNumber(body, "speedMps"),
    heartRate: elementNumber(body, "heartRateBpm"),
    steps: elementNumber(body, "stepCount"),
    cadence: elementNumber(body, "cadenceSpm"),
  });
}

function readSummary(text: string): GpxSummary | undefined {
  const start = text.indexOf("<metadata>");
  const end = text.indexOf("</metadata>", start);
  if (start < 0 || end < 0) return undefined;
  const meta = text.slice(start, end);
  const summary = dropUndefined<GpxSummary>({
    steps: elementNumber(meta, "stepCount"),
    // Active (gross minus resting), not gross: the resting baseline is not effort. A file without the active figure gives no calories, not gross.
    calories: elementNumber(meta, "caloriesActiveKcal"),
    heartRateAvg: elementNumber(meta, "averageHeartRateBpm"),
    heartRateMax: elementNumber(meta, "maxHeartRateBpm"),
    durationS: elementNumber(meta, "durationSeconds"),
    distanceM: elementNumber(meta, "distanceMeters"),
  });
  return Object.keys(summary).length > 0 ? summary : undefined;
}

// CheapRuler's constants (WGS84), as in app/src/estimates.js but without its integer rounding: at 3 s sampling a step is only a few metres, and whole-metre rounding would distort it.
function cheapDistanceM(a: TrackPoint, b: TrackPoint): number {
  const cos = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const cos2 = 2 * cos * cos - 1;
  const cos3 = 2 * cos * cos2 - cos;
  const cos4 = 2 * cos * cos3 - cos2;
  const cos5 = 2 * cos * cos4 - cos3;
  const kx = 111415.13 * cos - 94.55 * cos3 + 0.12 * cos5;
  const ky = 111132.09 - 566.05 * cos2 + 1.2 * cos4;
  let dLon = a.lon - b.lon;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  return Math.hypot(dLon * kx, (a.lat - b.lat) * ky);
}

export function parseGpx(text: string): ParsedGpx {
  const segmentStarts: number[] = [];
  for (let at = text.indexOf("<trkseg"); at >= 0; at = text.indexOf("<trkseg", at + 7)) {
    segmentStarts.push(at);
  }

  const points: TrackPoint[] = [];
  let trackDistanceM = 0;
  let segment = -1;
  let previous: TrackPoint | undefined;
  for (let at = text.indexOf("<trkpt"); at >= 0; at = text.indexOf("<trkpt", at + 6)) {
    const tagEnd = text.indexOf(">", at);
    if (tagEnd < 0) throw new GpxError("a track point is not closed");
    const tag = text.slice(at, tagEnd);
    let body = "";
    if (!tag.endsWith("/")) {
      const close = text.indexOf("</trkpt>", tagEnd);
      if (close < 0) throw new GpxError("a track point is not closed");
      body = text.slice(tagEnd + 1, close);
    }
    const point = readPoint(tag, body);

    let inSegment = segment;
    while (segmentStarts[inSegment + 1] !== undefined && (segmentStarts[inSegment + 1] ?? 0) < at) {
      inSegment++;
    }
    if (inSegment === segment && previous) trackDistanceM += cheapDistanceM(previous, point);
    segment = inSegment;
    previous = point;
    points.push(point);
  }
  if (points.length === 0) throw new GpxError("the file has no track points");

  let first = points[0]?.t ?? 0;
  let last = first;
  for (const p of points) {
    if (p.t < first) first = p.t;
    if (p.t > last) last = p.t;
  }
  const summary = readSummary(text);
  return {
    points,
    ...(summary ? { summary } : {}),
    startedAt: new Date(first).toISOString(),
    endedAt: new Date(last).toISOString(),
    trackDistanceM,
  };
}

/** The watch's own figures where it wrote them; the track fills in any it did not, and pace is derived from distance and duration. */
export function activityStats(parsed: ParsedGpx): ActivitySummary["stats"] {
  const s = parsed.summary;
  const durationS =
    s?.durationS ?? (Date.parse(parsed.endedAt) - Date.parse(parsed.startedAt)) / 1000;
  const distanceM = s?.distanceM ?? parsed.trackDistanceM;
  return dropUndefined<ActivitySummary["stats"]>({
    durationS,
    distanceM,
    paceSPerKm: distanceM > 0 && durationS > 0 ? durationS / (distanceM / 1000) : undefined,
    steps: s?.steps,
    calories: s?.calories,
    heartRateAvg: s?.heartRateAvg,
    heartRateMax: s?.heartRateMax,
  });
}
