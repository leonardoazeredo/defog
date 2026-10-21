import type { ActivitySummary, RouteRecord, TrackPoint } from "../src/bridge/protocol.js";
import type { FogCache } from "./fogCache.js";

// app/src/reveal.js `Reveal.RULES`: results are only comparable within one `version`.
interface RevealRules {
  version: number;
  maxAccuracyM: number;
  maxGapS: number;
  maxGapM: number;
  halfWidthM: number;
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
  /** Resolves when everything received so far has been applied; for tests. */
  settled(): Promise<void>;
}

// Keeps the page's explored cells equal to the import plus the reveal of every kept activity.
// The cache only saves re-revealing; the in-memory map is what a rebuild after a delete reads, so a
// disabled or broken cache costs one track request per activity on each start and nothing else.
export function createHistorySync(deps: HistorySyncDeps): HistorySync {
  const { pageApi, cache, page, rules } = deps;

  const revealed = new Map<string, Int32Array>();
  const requested = new Set<string>();
  const partial = new Map<string, PartialTrack>();
  let wanted = new Set<string>();

  // One job at a time: a rebuild must not clear the overlay while a reveal is still on its way in.
  let tail: Promise<void> = Promise.resolve();
  function enqueue(job: () => Promise<void>): void {
    tail = tail.then(job).catch(() => {
      // Fixed text: a message could carry positions, which must not reach logs.
      console.error("crossfog: updating the fog from the history failed");
    });
  }

  function rebuild(): void {
    page.fogMap.clearOverlay();
    for (const cells of revealed.values()) page.fogMap.addCells(cells);
  }

  async function cachedCells(id: string): Promise<Int32Array | null> {
    const hit = await cache.getReveal(id);
    if (hit == null || hit.rulesVersion !== rules.version) return null;
    // a whole number of [cx, cy] pairs, or the entry is damaged
    if (hit.cells.byteLength % 8 !== 0) return null;
    return new Int32Array(hit.cells);
  }

  async function applyList(items: ActivitySummary[]): Promise<void> {
    wanted = new Set(items.map((item) => item.id));

    let removed = false;
    for (const id of [...revealed.keys()]) {
      if (wanted.has(id)) continue;
      revealed.delete(id);
      removed = true;
    }
    for (const id of [...requested]) {
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
      const cells = await cachedCells(id);
      if (cells == null) {
        requested.add(id);
        pageApi.needTrack(id);
        continue;
      }
      revealed.set(id, cells);
      restored.push(cells);
    }

    if (removed) {
      rebuild();
      page.fogChanged();
    } else if (restored.length > 0) {
      // only the ones restored now: addCells bumps the fog version even when it adds nothing
      let added = 0;
      for (const cells of restored) added += page.fogMap.addCells(cells);
      if (added > 0) page.fogChanged();
    }
  }

  async function applyTrack(chunk: TrackChunk): Promise<void> {
    const { activityId, index, total, points } = chunk;
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

    page.history?.setTrack(activityId, track, got.route);
    if (!requested.has(activityId)) return;
    requested.delete(activityId);

    const cells = page.reveal.reveal(
      track.map((p) => ({ t: p.t, lat: p.lat, lon: p.lon, accuracy: p.accuracy })),
      rules,
    );
    await cache.putReveal(activityId, rules.version, cells);
    if (!wanted.has(activityId)) {
      await cache.deleteReveal(activityId);
      return;
    }
    revealed.set(activityId, cells);
    if (page.fogMap.addCells(cells) > 0) page.fogChanged();
  }

  return {
    onActivities: ({ items }) => {
      // Straight to the panel: it should not wait behind the cache.
      page.history?.setActivities(items);
      enqueue(() => applyList(items));
    },
    onTrack: (chunk) => enqueue(() => applyTrack(chunk)),
    settled: () => tail,
  };
}
