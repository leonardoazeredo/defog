import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import { unzlibSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySummary, TrackPoint } from "../../src/bridge/protocol.js";
import { type FogCache, openFogCache } from "../../web-adapter/fogCache.js";
import { type CrossfogPageApi, createHistorySync, stampFor } from "../../web-adapter/history.js";
import { installFakeUpstream } from "./support/fakeUpstream.js";

interface UpstreamFogMap {
  addTile(name: string, data: Uint8Array): boolean;
  totalVisited(): number;
  tiles: Map<number, { blocks(): Iterable<{ bx: number; by: number }> }>;
  isVisitedCell(cx: number, cy: number): boolean;
  clearOverlay(): void;
  addCells(cells: Int32Array): number;
}
interface Upstream {
  FogParser: {
    FogMap: new () => UpstreamFogMap;
    lngLatToCell(lng: number, lat: number): { cx: number; cy: number };
    cellToLngLat(cx: number, cy: number): { lng: number; lat: number };
  };
  Reveal: CrossfogPageApi["reveal"] & { RULES: { version: number } };
}

const win = window as unknown as Window & Upstream;
installFakeUpstream(window, document);
const { FogParser, Reveal } = win;

const WALKER = "11111111-1111-4111-8111-111111111111";
const RIDER = "22222222-2222-4222-8222-222222222222";

// A straight line due east at latitude 51; x is metres east of longitude 13.7.
const KX = 111320 * Math.cos((51 * Math.PI) / 180);
const lonAt = (x: number) => 13.7 + x / KX;
const visitedAt = (fog: UpstreamFogMap, x: number): boolean => {
  const c = FogParser.lngLatToCell(lonAt(x), 51);
  return fog.isVisitedCell(Math.floor(c.cx), Math.floor(c.cy));
};

function walk(fromM: number, toM: number): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (let x = fromM; x <= toM; x += 10) {
    points.push({ t: x * 700, lat: 51, lon: lonAt(x), accuracy: 5 });
  }
  return points;
}

// Two tiles Fog of World wrote; the first one's tile id is 117660 (tx 412, ty 229 of the 512-tile grid).
const FOW = resolve(dirname(fileURLToPath(import.meta.url)), "../../../bench/fixtures/fow");
const TILE_CELLS = 2 ** 22 / 512;

// A cell the fixture tile marks as explored, found in its first block.
function firstImportedCell(fog: UpstreamFogMap): { cx: number; cy: number } {
  const first = Array.from(
    (fog.tiles.get(117660) as NonNullable<ReturnType<typeof fog.tiles.get>>).blocks(),
  )[0];
  if (first == null) throw new Error("fixture tile has no block");
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const cx = 412 * TILE_CELLS + first.bx * 64 + x;
      const cy = 229 * TILE_CELLS + first.by * 64 + y;
      if (fog.isVisitedCell(cx, cy)) return { cx, cy };
    }
  }
  throw new Error("fixture block has no explored cell");
}

// A straight walk due east through the centre of a cell, `halfM` metres either side.
function walkThrough(cell: { cx: number; cy: number }, halfM: number): TrackPoint[] {
  const here = FogParser.cellToLngLat(cell.cx + 0.5, cell.cy + 0.5);
  const kx = 111320 * Math.cos((here.lat * Math.PI) / 180);
  const points: TrackPoint[] = [];
  for (let x = -halfM; x <= halfM; x += 10) {
    points.push({ t: (x + halfM) * 700, lat: here.lat, lon: here.lng + x / kx, accuracy: 5 });
  }
  return points;
}

function summary(
  id: string,
  changes: { endedAt?: string; distanceM?: number } = {},
): ActivitySummary {
  return {
    id,
    travelMode: "walk",
    startedAt: "2026-01-01T10:00:00Z",
    endedAt: changes.endedAt ?? "2026-01-01T11:00:00Z",
    stats: { durationS: 3600, distanceM: changes.distanceM ?? 1000 },
  };
}

// Sends a track the way the native side does, in chunks; `order` reshuffles delivery to check chunks are joined by index.
function sendTrack(
  sync: {
    onTrack(c: {
      activityId: string;
      index: number;
      total: number;
      points: TrackPoint[];
      route?: { coords: Array<[number, number]> };
    }): void;
  },
  activityId: string,
  points: TrackPoint[],
  perChunk = 20,
  order?: (indices: number[]) => number[],
  route?: { coords: Array<[number, number]> },
): void {
  const total = Math.max(1, Math.ceil(points.length / perChunk));
  const indices = order ? order([...Array(total).keys()]) : [...Array(total).keys()];
  for (const index of indices) {
    sync.onTrack({
      activityId,
      index,
      total,
      points: points.slice(index * perChunk, (index + 1) * perChunk),
      ...(index === 0 && route ? { route } : {}),
    });
  }
}

let idb: IDBFactory;
beforeEach(() => {
  idb = new IDBFactory();
});

async function setup(
  options: { cache?: FogCache; rulesVersion?: number; halfWidthM?: number; panel?: boolean } = {},
) {
  const fogMap = new FogParser.FogMap();
  const cache = options.cache ?? (await openFogCache(idb, true));
  const fogChanged = vi.fn();
  const needTrack = vi.fn();
  const rules = {
    ...Reveal.RULES,
    version: options.rulesVersion ?? Reveal.RULES.version,
    halfWidthM: options.halfWidthM ?? Reveal.RULES.halfWidthM,
  };
  const history = { setActivities: vi.fn(), setTrack: vi.fn() };
  const page: CrossfogPageApi = {
    fogMap,
    fogChanged,
    reveal: Reveal,
    ...(options.panel === false ? {} : { history }),
  };
  const sync = createHistorySync({ pageApi: { needTrack }, cache, page, rules });
  const lists = (...ids: string[]) => sync.onActivities({ items: ids.map((id) => summary(id)) });
  return { fogMap, cache, fogChanged, needTrack, sync, lists, rules, history };
}

describe("asking for tracks", () => {
  it("asks for the track of an activity it has no reveal for", async () => {
    const { lists, needTrack, sync } = await setup();
    lists(WALKER, RIDER);
    await sync.settled();
    expect(needTrack.mock.calls.map((c) => c[0]).sort()).toEqual([WALKER, RIDER].sort());
  });

  it("does not ask twice while a track is on its way", async () => {
    const { lists, needTrack, sync } = await setup();
    lists(WALKER);
    lists(WALKER);
    await sync.settled();
    expect(needTrack).toHaveBeenCalledTimes(1);
  });

  it("asks again for both tracks when the reveal rules changed", async () => {
    const first = await setup({ rulesVersion: 1 });
    first.lists(WALKER, RIDER);
    sendTrack(first.sync, WALKER, walk(0, 300));
    sendTrack(first.sync, RIDER, walk(200, 500));
    await first.sync.settled();

    const second = await setup({ cache: first.cache, rulesVersion: 2 });
    second.lists(WALKER, RIDER);
    await second.sync.settled();
    expect(second.needTrack.mock.calls.map((c) => c[0]).sort()).toEqual([WALKER, RIDER].sort());
    expect(visitedAt(second.fogMap, 50)).toBe(false);
  });
});

describe("a cached reveal is reused unless the rules or the activity end time or distance changed", () => {
  async function revealedOnce() {
    const first = await setup();
    first.lists(WALKER);
    sendTrack(first.sync, WALKER, walk(0, 300));
    await first.sync.settled();
    return first;
  }

  it("reuses an unchanged entry without asking for the track", async () => {
    const first = await revealedOnce();
    const again = await setup({ cache: first.cache });
    again.lists(WALKER);
    await again.sync.settled();
    expect(again.needTrack).not.toHaveBeenCalled();
    expect(visitedAt(again.fogMap, 50)).toBe(true);
  });

  it("asks again when halfWidthM changed under the same version", async () => {
    const first = await revealedOnce();
    const tuned = await setup({ cache: first.cache, halfWidthM: Reveal.RULES.halfWidthM + 10 });
    tuned.lists(WALKER);
    await tuned.sync.settled();
    expect(tuned.needTrack).toHaveBeenCalledWith(WALKER);
    expect(visitedAt(tuned.fogMap, 50)).toBe(false);
  });

  it("asks again when the track under the same id ended at another time", async () => {
    const first = await revealedOnce();
    const again = await setup({ cache: first.cache });
    again.sync.onActivities({ items: [summary(WALKER, { endedAt: "2026-01-02T11:00:00Z" })] });
    await again.sync.settled();
    expect(again.needTrack).toHaveBeenCalledWith(WALKER);
  });

  it("asks again when the track under the same id has another distance", async () => {
    const first = await revealedOnce();
    const again = await setup({ cache: first.cache });
    again.sync.onActivities({ items: [summary(WALKER, { distanceM: 2500 })] });
    await again.sync.settled();
    expect(again.needTrack).toHaveBeenCalledWith(WALKER);
  });

  it("stamps a track with the activity as it was when the track was asked for", async () => {
    const s = await setup();
    s.lists(WALKER);
    await s.sync.settled();
    s.sync.onActivities({ items: [summary(WALKER, { distanceM: 2500 })] });
    sendTrack(s.sync, WALKER, walk(0, 300));
    await s.sync.settled();
    const later = await setup({ cache: s.cache });
    later.sync.onActivities({ items: [summary(WALKER, { distanceM: 2500 })] });
    await later.sync.settled();
    expect(later.needTrack).toHaveBeenCalledWith(WALKER);
  });

  it("hashes the rules whatever order their keys are in", () => {
    const a = stampFor(Reveal.RULES, summary(WALKER));
    const reordered = Object.fromEntries(Object.entries(Reveal.RULES).reverse());
    expect(stampFor(reordered as typeof Reveal.RULES, summary(WALKER)).rulesHash).toBe(a.rulesHash);
    const tuned = { ...Reveal.RULES, halfWidthM: Reveal.RULES.halfWidthM + 1 };
    expect(stampFor(tuned, summary(WALKER)).rulesHash).not.toBe(a.rulesHash);
  });

  it("overwrites the old entry with the recomputed one", async () => {
    const first = await revealedOnce();
    const tuned = await setup({ cache: first.cache, halfWidthM: Reveal.RULES.halfWidthM + 10 });
    tuned.lists(WALKER);
    sendTrack(tuned.sync, WALKER, walk(0, 300));
    await tuned.sync.settled();
    const later = await setup({ cache: first.cache, halfWidthM: Reveal.RULES.halfWidthM + 10 });
    later.lists(WALKER);
    await later.sync.settled();
    expect(later.needTrack).not.toHaveBeenCalled();
  });
});

describe("a track request that is never answered", () => {
  const chunk = (activityId: string, index: number, total: number) => ({
    activityId,
    index,
    total,
    points: walk(index * 100, index * 100 + 90),
  });

  it("is asked for again by the second later list that came with no chunk", async () => {
    const { lists, needTrack, sync } = await setup();
    lists(WALKER);
    await sync.settled();
    lists(WALKER);
    await sync.settled();
    expect(needTrack).toHaveBeenCalledTimes(1);
    lists(WALKER);
    await sync.settled();
    expect(needTrack).toHaveBeenCalledTimes(2);
  });

  it("is not asked again while chunks keep arriving", async () => {
    const { lists, needTrack, sync } = await setup();
    lists(WALKER);
    lists(WALKER);
    sync.onTrack(chunk(WALKER, 0, 3));
    lists(WALKER);
    sync.onTrack(chunk(WALKER, 1, 3));
    lists(WALKER);
    await sync.settled();
    expect(needTrack).toHaveBeenCalledTimes(1);
  });

  it("drops the half-received chunks and takes the whole track from the new request", async () => {
    const { lists, needTrack, sync, fogMap } = await setup();
    lists(WALKER);
    sync.onTrack(chunk(WALKER, 0, 3));
    lists(WALKER);
    lists(WALKER);
    lists(WALKER);
    await sync.settled();
    expect(needTrack).toHaveBeenCalledTimes(2);
    // same total, so only forgetting the old chunk 0 keeps its cells (x 0-90) off the overlay
    sync.onTrack({ activityId: WALKER, index: 0, total: 3, points: walk(1000, 1090) });
    sync.onTrack({ activityId: WALKER, index: 1, total: 3, points: walk(1100, 1190) });
    sync.onTrack({ activityId: WALKER, index: 2, total: 3, points: walk(1200, 1290) });
    await sync.settled();
    expect(visitedAt(fogMap, 1050)).toBe(true);
    expect(visitedAt(fogMap, 50)).toBe(false);
  });

  it("is not kept waiting by chunks of another activity's track", async () => {
    const { lists, needTrack, sync } = await setup();
    lists(WALKER, RIDER);
    lists(WALKER, RIDER);
    sync.onTrack(chunk(RIDER, 0, 3));
    lists(WALKER, RIDER);
    await sync.settled();
    expect(needTrack.mock.calls.filter((c) => c[0] === WALKER)).toHaveLength(2);
    expect(needTrack.mock.calls.filter((c) => c[0] === RIDER)).toHaveLength(1);
  });
});

describe("a track the phone could not send", () => {
  it.each(["notFound", "readFailed"] as const)(
    "is asked for again by the next list after %s, not at once",
    async (reason) => {
      const { sync, lists, needTrack } = await setup();
      lists(WALKER);
      await sync.settled();
      sync.onTrackUnavailable({ activityId: WALKER, reason });
      await sync.settled();
      expect(needTrack).toHaveBeenCalledTimes(1);
      lists(WALKER);
      await sync.settled();
      expect(needTrack).toHaveBeenCalledTimes(2);
    },
  );

  it("drops the chunks of a half-received track", async () => {
    const { sync, lists, fogMap } = await setup();
    lists(WALKER);
    sync.onTrack({ activityId: WALKER, index: 0, total: 3, points: walk(0, 90) });
    sync.onTrackUnavailable({ activityId: WALKER, reason: "readFailed" });
    lists(WALKER);
    sendTrack(sync, WALKER, walk(0, 300), 100);
    await sync.settled();
    expect(visitedAt(fogMap, 250)).toBe(true);
  });
});

describe("a track replaced under the same id in a live session", () => {
  it("is asked for again and its old cells are taken off the overlay", async () => {
    const { sync, lists, needTrack, fogMap } = await setup();
    lists(WALKER);
    sendTrack(sync, WALKER, walk(0, 300));
    await sync.settled();
    expect(visitedAt(fogMap, 50)).toBe(true);

    sync.onActivities({ items: [summary(WALKER, { distanceM: 2500 })] });
    await sync.settled();
    expect(needTrack).toHaveBeenCalledTimes(2);
    expect(visitedAt(fogMap, 50)).toBe(false);

    sendTrack(sync, WALKER, walk(1000, 1300));
    await sync.settled();
    expect(visitedAt(fogMap, 1050)).toBe(true);
    expect(visitedAt(fogMap, 50)).toBe(false);
  });

  it("is left alone when the list repeats the activity unchanged", async () => {
    const { sync, lists, needTrack } = await setup();
    lists(WALKER);
    sendTrack(sync, WALKER, walk(0, 300));
    await sync.settled();
    lists(WALKER);
    await sync.settled();
    expect(needTrack).toHaveBeenCalledTimes(1);
  });
});

describe("revealing", () => {
  it("adds the cells of both activities to the overlay once their tracks are in", async () => {
    const { lists, sync, fogMap } = await setup();
    lists(WALKER, RIDER);
    sendTrack(sync, WALKER, walk(0, 300));
    sendTrack(sync, RIDER, walk(200, 500));
    await sync.settled();
    expect(visitedAt(fogMap, 50)).toBe(true);
    expect(visitedAt(fogMap, 250)).toBe(true);
    expect(visitedAt(fogMap, 450)).toBe(true);
    expect(visitedAt(fogMap, 800)).toBe(false);
  });

  it("tells the page once per activity that finished", async () => {
    const { lists, sync, fogChanged } = await setup();
    lists(WALKER);
    sendTrack(sync, WALKER, walk(0, 300), 5);
    await sync.settled();
    expect(fogChanged).toHaveBeenCalledTimes(1);
  });

  it("waits for the last chunk, whatever order they arrive in", async () => {
    const { lists, sync, fogMap, fogChanged } = await setup();
    lists(WALKER);
    const points = walk(0, 300);
    const total = Math.ceil(points.length / 10);
    sync.onTrack({
      activityId: WALKER,
      index: total - 1,
      total,
      points: points.slice((total - 1) * 10),
    });
    await sync.settled();
    expect(fogChanged).not.toHaveBeenCalled();
    expect(visitedAt(fogMap, 50)).toBe(false);
    sendTrack(sync, WALKER, points, 10, (i) => i.slice(0, -1).reverse());
    await sync.settled();
    expect(fogChanged).toHaveBeenCalledTimes(1);
    expect(visitedAt(fogMap, 50)).toBe(true);
    expect(visitedAt(fogMap, 150)).toBe(true);
  });

  it("ignores a track nobody asked for", async () => {
    const { sync, fogMap, fogChanged } = await setup();
    sendTrack(sync, WALKER, walk(0, 300));
    await sync.settled();
    expect(visitedAt(fogMap, 50)).toBe(false);
    expect(fogChanged).not.toHaveBeenCalled();
  });

  it("does not tell the page when the walk was all on explored ground", async () => {
    const { lists, sync, fogMap, fogChanged } = await setup();
    fogMap.addCells(Reveal.reveal(walk(0, 300), Reveal.RULES));
    lists(WALKER);
    sendTrack(sync, WALKER, walk(0, 300));
    await sync.settled();
    expect(fogChanged).not.toHaveBeenCalled();
  });
});

describe("restoring from the cache", () => {
  it("fills a fresh overlay from the cache without asking for tracks, telling the page once", async () => {
    const first = await setup();
    first.lists(WALKER, RIDER);
    sendTrack(first.sync, WALKER, walk(0, 300));
    sendTrack(first.sync, RIDER, walk(200, 500));
    await first.sync.settled();

    const restarted = await setup({ cache: first.cache });
    restarted.lists(WALKER, RIDER);
    await restarted.sync.settled();
    expect(restarted.needTrack).not.toHaveBeenCalled();
    expect(visitedAt(restarted.fogMap, 50)).toBe(true);
    expect(visitedAt(restarted.fogMap, 450)).toBe(true);
    expect(restarted.fogChanged).toHaveBeenCalledTimes(1);
  });

  it("asks only for the activities the cache lacks", async () => {
    const first = await setup();
    first.lists(WALKER);
    sendTrack(first.sync, WALKER, walk(0, 300));
    await first.sync.settled();

    const restarted = await setup({ cache: first.cache });
    restarted.lists(WALKER, RIDER);
    await restarted.sync.settled();
    expect(restarted.needTrack.mock.calls.map((c) => c[0])).toEqual([RIDER]);
    expect(visitedAt(restarted.fogMap, 50)).toBe(true);
  });

  it("treats a damaged cache entry as missing", async () => {
    const { lists, sync, cache, needTrack } = await setup();
    await cache.putReveal(
      WALKER,
      stampFor(win.Reveal.RULES, summary(WALKER)),
      new Int32Array([1, 2, 3]),
    );
    const raw = await cache.getReveal(WALKER);
    expect(raw?.cells.byteLength).toBe(12);
    lists(WALKER);
    await sync.settled();
    expect(needTrack).toHaveBeenCalledWith(WALKER);
  });

  it("forgets reveals of activities deleted while the page was closed", async () => {
    const first = await setup();
    first.lists(WALKER, RIDER);
    sendTrack(first.sync, WALKER, walk(0, 300));
    sendTrack(first.sync, RIDER, walk(200, 500));
    await first.sync.settled();

    const restarted = await setup({ cache: first.cache });
    restarted.lists(WALKER);
    await restarted.sync.settled();
    expect(await restarted.cache.revealIds()).toEqual([WALKER]);
    expect(visitedAt(restarted.fogMap, 450)).toBe(false);
    expect(visitedAt(restarted.fogMap, 50)).toBe(true);
  });
});

describe("deleting an activity", () => {
  async function bothRevealed() {
    const s = await setup();
    s.lists(WALKER, RIDER);
    sendTrack(s.sync, WALKER, walk(0, 300));
    sendTrack(s.sync, RIDER, walk(200, 500));
    await s.sync.settled();
    s.fogChanged.mockClear();
    return s;
  }

  it("removes the cells only it revealed and keeps the ones another activity covers", async () => {
    const s = await bothRevealed();
    s.lists(WALKER);
    await s.sync.settled();
    expect(visitedAt(s.fogMap, 450)).toBe(false);
    expect(visitedAt(s.fogMap, 250)).toBe(true);
    expect(visitedAt(s.fogMap, 50)).toBe(true);
    expect(s.fogChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps the shared cells whichever of the two is deleted", async () => {
    const s = await bothRevealed();
    s.lists(RIDER);
    await s.sync.settled();
    expect(visitedAt(s.fogMap, 50)).toBe(false);
    expect(visitedAt(s.fogMap, 250)).toBe(true);
    expect(visitedAt(s.fogMap, 450)).toBe(true);
  });

  it("leaves the cells the import covers", async () => {
    const s = await setup();
    const name = "23e4lltkkoke";
    const tile = unzlibSync(readFileSync(resolve(FOW, name)));
    s.fogMap.addTile(name, tile);
    const onImport = firstImportedCell(s.fogMap);
    const before = s.fogMap.totalVisited();
    s.lists(WALKER);
    sendTrack(s.sync, WALKER, walkThrough(onImport, 150));
    await s.sync.settled();
    expect(s.fogMap.totalVisited()).toBeGreaterThan(before);
    s.lists();
    await s.sync.settled();
    expect(s.fogMap.isVisitedCell(onImport.cx, onImport.cy)).toBe(true);
    expect(s.fogMap.totalVisited()).toBe(before);
  });

  it("drops its cached reveal", async () => {
    const s = await bothRevealed();
    s.lists(WALKER);
    await s.sync.settled();
    expect(await s.cache.revealIds()).toEqual([WALKER]);
  });

  it("drops a track that arrives after the activity was deleted", async () => {
    const s = await setup();
    s.lists(WALKER);
    s.lists();
    sendTrack(s.sync, WALKER, walk(0, 300));
    await s.sync.settled();
    expect(visitedAt(s.fogMap, 50)).toBe(false);
    expect(await s.cache.revealIds()).toEqual([]);
  });

  it("does not lose a reveal that is still being stored when the list changes", async () => {
    const s = await setup();
    s.lists(WALKER, RIDER);
    sendTrack(s.sync, WALKER, walk(0, 300));
    sendTrack(s.sync, RIDER, walk(200, 500));
    s.lists(WALKER);
    await s.sync.settled();
    expect(visitedAt(s.fogMap, 50)).toBe(true);
    expect(visitedAt(s.fogMap, 450)).toBe(false);
  });
});

describe("without a cache", () => {
  it("still reveals and still undoes a delete", async () => {
    const cache = await openFogCache(idb, false);
    const s = await setup({ cache });
    s.lists(WALKER, RIDER);
    sendTrack(s.sync, WALKER, walk(0, 300));
    sendTrack(s.sync, RIDER, walk(200, 500));
    await s.sync.settled();
    expect(visitedAt(s.fogMap, 450)).toBe(true);
    s.lists(WALKER);
    await s.sync.settled();
    expect(visitedAt(s.fogMap, 450)).toBe(false);
    expect(visitedAt(s.fogMap, 250)).toBe(true);
  });
});

describe("failures", () => {
  it("logs a fixed line without positions and carries on after a failed job", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fogMap = new FogParser.FogMap();
    const fogChanged = vi.fn();
    const throwing = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("bad point 51.123456,13.654321");
      })
      .mockImplementation(Reveal.reveal);
    const page: CrossfogPageApi = {
      fogMap,
      fogChanged,
      reveal: { RULES: Reveal.RULES, reveal: throwing },
    };
    const sync = createHistorySync({
      pageApi: { needTrack: vi.fn() },
      cache: await openFogCache(idb, false),
      page,
      rules: Reveal.RULES,
    });
    sync.onActivities({ items: [summary(WALKER), summary(RIDER)] });
    sendTrack(sync, WALKER, walk(0, 300));
    sendTrack(sync, RIDER, walk(200, 500));
    await sync.settled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/51\.1234|13\.6543/);
    expect(visitedAt(fogMap, 450)).toBe(true);
    expect(visitedAt(fogMap, 50)).toBe(false);
    error.mockRestore();
  });
});

describe("the history panel", () => {
  it("is handed every list as it arrives, before any fog work", async () => {
    const { lists, history } = await setup();
    lists(WALKER, RIDER);
    expect(history.setActivities).toHaveBeenCalledTimes(1);
    expect(history.setActivities.mock.calls[0]?.[0].map((i: ActivitySummary) => i.id)).toEqual([
      WALKER,
      RIDER,
    ]);
  });

  it("is handed an assembled track, in point order, with the route from the first chunk", async () => {
    const { lists, sync, history } = await setup();
    lists(WALKER);
    const points = walk(0, 300);
    const route: { coords: Array<[number, number]> } = {
      coords: [
        [13.7, 51],
        [13.71, 51],
      ],
    };
    sendTrack(sync, WALKER, points, 10, (i) => i.reverse(), route);
    await sync.settled();

    expect(history.setTrack).toHaveBeenCalledTimes(1);
    const [id, got, gotRoute] = history.setTrack.mock.calls[0] ?? [];
    expect(id).toBe(WALKER);
    expect(got).toEqual(points);
    expect(gotRoute).toEqual(route);
  });

  it("gets a track the fog did not ask for, and leaves the fog alone", async () => {
    const first = await setup();
    first.lists(WALKER);
    sendTrack(first.sync, WALKER, walk(0, 300));
    await first.sync.settled();
    first.fogChanged.mockClear();

    // the reveal is cached now, so a card tapped later asks for a track the fog never requests
    const second = await setup({ cache: first.cache });
    second.lists(WALKER);
    await second.sync.settled();
    expect(second.needTrack).not.toHaveBeenCalled();
    second.fogChanged.mockClear();

    sendTrack(second.sync, WALKER, walk(0, 300));
    await second.sync.settled();
    expect(second.history.setTrack).toHaveBeenCalledTimes(1);
    expect(second.fogChanged).not.toHaveBeenCalled();
  });

  it("drops a half-received track when its activity leaves the list", async () => {
    const { lists, sync, history } = await setup();
    lists(WALKER);
    sync.onTrack({ activityId: WALKER, index: 0, total: 2, points: walk(0, 100) });
    lists();
    await sync.settled();
    sync.onTrack({ activityId: WALKER, index: 1, total: 2, points: walk(110, 200) });
    await sync.settled();
    expect(history.setTrack).not.toHaveBeenCalled();
  });

  it("keeps the fog working when the page has no history panel", async () => {
    const { lists, sync, fogMap } = await setup({ panel: false });
    lists(WALKER);
    sendTrack(sync, WALKER, walk(0, 300));
    await sync.settled();
    expect(visitedAt(fogMap, 50)).toBe(true);
  });

  it("still shows a track when saving the reveal fails", async () => {
    const cache = await openFogCache(idb, true);
    const broken: FogCache = {
      ...cache,
      putReveal: async () => {
        throw new Error("quota");
      },
    };
    const { lists, sync, history } = await setup({ cache: broken });
    vi.spyOn(console, "error").mockImplementation(() => {});
    lists(WALKER);
    sendTrack(sync, WALKER, walk(0, 300));
    await sync.settled();
    expect(history.setTrack).toHaveBeenCalledTimes(1);
  });
});

describe("a panel that throws", () => {
  it("does not stop the fog from following the list or a track", async () => {
    const { lists, sync, history, fogMap } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    history.setActivities.mockImplementation(() => {
      throw new Error("boom");
    });
    history.setTrack.mockImplementation(() => {
      throw new Error("boom");
    });
    lists(WALKER);
    sendTrack(sync, WALKER, walk(0, 300));
    await sync.settled();
    expect(visitedAt(fogMap, 50)).toBe(true);
  });

  it("logs a fixed line, never the error text", async () => {
    const { lists, history } = await setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    history.setActivities.mockImplementation(() => {
      throw new Error("51.4777, 0.0002");
    });
    lists(WALKER);
    expect(JSON.stringify(log.mock.calls)).not.toContain("51.4777");
    expect(log).toHaveBeenCalledWith("crossfog: updating the history panel failed");
  });
});
