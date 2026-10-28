import type { ActivitySummary, RouteRecord, TrackPoint } from "../src/bridge/protocol.js";
import type { FogCache, RevealStamp } from "./fogCache.js";

// app/src/reveal.js `Reveal.RULES`: a cached reveal is reused only while a hash of all these fields matches.
interface RevealRules {
  version: number;
  maxAccuracyM: number;
  maxGapS: number;
  maxGapM: number;
  halfWidthM: number;
}

// FNV-1a over the rules with sorted keys: it only has to notice a changed number, not resist forgery.
function hashRules(rules: RevealRules): string {
  const entries = Object.entries(rules).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const text = JSON.stringify(entries);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function stampFor(rules: RevealRules, item: ActivitySummary): RevealStamp {
  return {
    rulesVersion: rules.version,
    rulesHash: hashRules(rules),
    endedAt: item.endedAt,
    distanceM: item.stats.distanceM,
  };
}

type RouteGeometry = { coords: RouteRecord["coords"] };

// What app/src/main.js hands the adapter as `window.CrossfogPage`.
export interface CrossfogPageApi {
  fogMap: {
    addCells(cells: Int32Array): number;
    clearOverlay(): void;
  };
  fogChanged(): void;
  /** The History tab; absent on a page without it. */
  history?: {
    setActivities(items: ActivitySummary[]): void;
    setTrack(activityId: string, points: TrackPoint[], route?: RouteGeometry): void;
    trackUnavailable?(activityId: string, reason: "notFound" | "readFailed"): void;
    setUnreadable?(count: number): void;
  };
  /** The Send button's answers from the phone. */
  routeStatus?(msg: { routeId: string; state: string; why?: string | undefined }): void;
  linkStatus?(msg: { paired: boolean; reachable: boolean }): void;
  reveal: {
    RULES: RevealRules;
    reveal(
      track: Array<{ t: number; lat: number; lon: number; accuracy?: number | undefined }>,
      rules: RevealRules,
    ): Int32Array;
  };
}

declare global {
  interface Window {
    CrossfogPage?: CrossfogPageApi;
  }
}

interface TrackChunk {
  activityId: string;
  index: number;
  total: number;
  points: TrackPoint[];
  route?: RouteGeometry | undefined;
}

interface PartialTrack {
  total: number;
  chunks: Map<number, TrackPoint[]>;
  route?: RouteGeometry | undefined;
}

export interface HistorySyncDeps {
  pageApi: { needTrack(activityId: string): void };
  cache: FogCache;
  page: CrossfogPageApi;
  rules: RevealRules;
}

export interface HistorySync {
  onActivities(payload: { items: ActivitySummary[] }): void;
  onTrack(chunk: TrackChunk): void;
  /** The phone answered a track request with no track: a readFailed id is asked for again by the next list that holds it; a notFound id has left the phone's list. */
  onTrackUnavailable(payload: { activityId: string; reason: "notFound" | "readFailed" }): void;
  /** Resolves when everything received so far has been applied; for tests. */
  settled(): Promise<void>;
}

// Keeps the page's explored cells equal to the import plus the reveal of every kept activity.
// The cache only saves re-revealing; the in-memory map is what a rebuild after a delete reads, so a
// disabled or broken cache costs one track request per activity on each start and nothing else.
export function createHistorySync(deps: HistorySyncDeps): HistorySync {
  const { pageApi, cache, page, rules } = deps;

  // The stamp (rules, end time, distance) the cells were revealed under, so a list that changes any of them replaces a revealed track under the same id (one still in flight is checked by the next list).
  const revealed = new Map<string, { cells: Int32Array; stamp: RevealStamp }>();
  // The stamp is taken when a track is asked for: a list that changes the activity meanwhile must not stamp the old track as current.
  const requested = new Map<string, RevealStamp>();
  const partial = new Map<string, PartialTrack>();
  // No timer: a list only marks the requested ids that got no chunk since the previous list (`silent`); the next list
  // forgets the ones still without a chunk and asks again. A chunk resets the count for its own id only, as chunks of
  // other tracks (the panel's) say nothing about this one.
  let chunked = new Set<string>();
  let silent = new Set<string>();
  let wanted = new Set<string>();

  // One job at a time: a rebuild must not clear the overlay while a reveal is still on its way in.
  let tail: Promise<void> = Promise.resolve();
  function enqueue(job: () => Promise<void>): void {
    tail = tail.then(job).catch(() => {
      // Fixed text: a message could carry positions, which must not reach logs.
      console.error("crossfog: updating the fog from the history failed");
    });
  }

  // The panel is a view: a failure in it must not cost the fog its update. Fixed text, as a message could carry positions.
  function showInPanel(show: () => void): void {
    try {
      show();
    } catch {
      console.error("crossfog: updating the history panel failed");
    }
  }

  function rebuild(): void {
    page.fogMap.clearOverlay();
    for (const { cells } of revealed.values()) page.fogMap.addCells(cells);
  }

  async function cachedCells(item: ActivitySummary): Promise<Int32Array | null> {
    const hit = await cache.getReveal(item.id);
    if (hit == null) return null;
    const now = stampFor(rules, item);
    if (
      hit.rulesVersion !== now.rulesVersion ||
      hit.rulesHash !== now.rulesHash ||
      hit.endedAt !== now.endedAt ||
      hit.distanceM !== now.distanceM
    ) {
      return null;
    }
    // a whole number of [cx, cy] pairs, or the entry is damaged
    if (hit.cells.byteLength % 8 !== 0) return null;
    return new Int32Array(hit.cells);
  }

  // Forgets the request and any half-received chunks, so the next list that wants the id and has no cells asks again.
  function forgetRequest(id: string): void {
    requested.delete(id);
    partial.delete(id);
  }

  function sameStamp(a: RevealStamp, b: RevealStamp): boolean {
    return (
      a.rulesVersion === b.rulesVersion &&
      a.rulesHash === b.rulesHash &&
      a.endedAt === b.endedAt &&
      a.distanceM === b.distanceM
    );
  }

  async function applyList(items: ActivitySummary[]): Promise<void> {
    wanted = new Set(items.map((item) => item.id));
    const summaries = new Map(items.map((item) => [item.id, item]));

    for (const id of silent) {
      if (!chunked.has(id)) forgetRequest(id);
    }
    silent = new Set([...requested.keys()].filter((id) => !chunked.has(id)));
    chunked = new Set();

    let removed = false;
    for (const [id, entry] of [...revealed]) {
      const item = summaries.get(id);
      // the track under this id was replaced: its cells go, and the restore loop below takes it from the reveal cache or asks again
      if (item != null && !sameStamp(entry.stamp, stampFor(rules, item))) {
        revealed.delete(id);
        removed = true;
      }
    }
    for (const id of [...revealed.keys()]) {
      if (wanted.has(id)) continue;
      revealed.delete(id);
      removed = true;
    }
    for (const id of [...requested.keys()]) {
      if (!wanted.has(id)) requested.delete(id);
    }
    // the panel asks for tracks too, so a half-received one may belong to an id the fog never requested
    for (const id of [...partial.keys()]) {
      if (!wanted.has(id)) partial.delete(id);
    }
    // reveals left on disk by an activity deleted while the page was closed
    for (const id of await cache.revealIds()) {
      if (!wanted.has(id)) await cache.deleteReveal(id);
    }

    const restored: Int32Array[] = [];
    for (const id of wanted) {
      if (revealed.has(id) || requested.has(id)) continue;
      const item = summaries.get(id);
      if (item == null) continue;
      const cells = await cachedCells(item);
      if (cells == null) {
        requested.set(id, stampFor(rules, item));
        pageApi.needTrack(id);
        continue;
      }
      revealed.set(id, { cells, stamp: stampFor(rules, item) });
      restored.push(cells);
    }

    if (removed) {
      rebuild();
      page.fogChanged();
    } else if (restored.length > 0) {
      // only the ones restored now: the others' cells are in the overlay already
      let added = 0;
      for (const cells of restored) added += page.fogMap.addCells(cells);
      if (added > 0) page.fogChanged();
    }
  }

  async function applyTrack(chunk: TrackChunk): Promise<void> {
    const { activityId, index, total, points } = chunk;
    chunked.add(activityId);
    // The panel asks for tracks the fog never requests (a reveal is cached), so every list member's chunks are joined.
    if (!wanted.has(activityId)) return;

    let got = partial.get(activityId);
    if (got == null || got.total !== total) {
      got = { total, chunks: new Map() };
      partial.set(activityId, got);
    }
    got.chunks.set(index, points);
    if (chunk.route != null) got.route = chunk.route;
    if (got.chunks.size < total) return;

    partial.delete(activityId);
    const track: TrackPoint[] = [];
    for (let i = 0; i < total; i++) track.push(...(got.chunks.get(i) ?? []));

    showInPanel(() => page.history?.setTrack(activityId, track, got.route));
    const stamp = requested.get(activityId);
    if (stamp == null) return;
    requested.delete(activityId);

    const cells = page.reveal.reveal(
      track.map((p) => ({ t: p.t, lat: p.lat, lon: p.lon, accuracy: p.accuracy })),
      rules,
    );
    await cache.putReveal(activityId, stamp, cells);
    if (!wanted.has(activityId)) {
      await cache.deleteReveal(activityId);
      return;
    }
    revealed.set(activityId, { cells, stamp });
    if (page.fogMap.addCells(cells) > 0) page.fogChanged();
  }

  return {
    onActivities: ({ items }) => {
      // Straight to the panel: it should not wait behind the cache.
      showInPanel(() => page.history?.setActivities(items));
      enqueue(() => applyList(items));
    },
    onTrack: (chunk) => enqueue(() => applyTrack(chunk)),
    // Not asked here: an immediate retry of a failing read would loop, and a notFound id leaves the next list anyway.
    onTrackUnavailable: ({ activityId }) => enqueue(async () => forgetRequest(activityId)),
    settled: () => tail,
  };
}
