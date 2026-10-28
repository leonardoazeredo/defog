// StreetIndex: near its segment cap the index drops the least recently used pieces, never one a running or held run covers; synthetic streets, no network.
//   node bench/streets-lru.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { StreetIndex } = global;

// piece i is tile 548+i:2040, lon 13.7+0.025i to 13.725+0.025i, lat 51.0-51.025, about 1750 m wide
const pos = (i) => (548 + i) + ":2040";
const rect = (i) => StreetIndex.tileBounds({ x: 548 + i, y: 2040 });
const lon = (i, d) => (548 + i) * 0.025 + d;
// a way along lat 51.01 between two longitudes: 0.021° is about 1471 m, 29 segments of ~50 m
const line = (id, a, b) => ({ id, nodes: [id * 10, id * 10 + 1], geometry: [{ lat: 51.01, lon: a }, { lat: 51.01, lon: b }] });
const inPiece = (id, i) => line(id, lon(i, 0.002), lon(i, 0.023));
const answer = (...ways) => ({ ways, groups: {} });
// a cap of 100 starts dropping pieces past 85 segments and drops them down to 70
const MAX = 100;

// A source answering a normal run from `fresh` and a cache-only read with `cached` (as the street cache does,
// through onTile) or `expired` (in the Map alone); records the pieces each normal run asks for.
function source({ fresh = {}, cached = {}, expired = {} }) {
  const asked = [];
  const fetchStreets = async (tiles, kind, onTile, opts) => {
    const out = new Map();
    const cacheOnly = opts && opts.cacheOnly;
    if (!cacheOnly) asked.push(tiles.map((t) => t.x + ":" + t.y));
    for (const t of tiles) {
      const k = t.x + ":" + t.y;
      if (cacheOnly) {
        if (cached[k]) { out.set(k, cached[k]); onTile(t, cached[k], { cached: true }); } else if (expired[k]) out.set(k, expired[k]);
        continue;
      }
      out.set(k, fresh[k]);
      onTile(t, fresh[k]);
    }
    return out;
  };
  return { fetchStreets, asked };
}
const segList = (s) => [...s.segs.values()].flat();
const consistent = (s) => {
  assert.equal(s.segCount, segList(s).length, "segCount counts the segments held");
  assert.deepEqual([...s.wayIds].sort(), s.ways.map((w) => w.id).sort(), "wayIds names the ways held");
};
const held = (s, i) => s.tiles.has("run:" + pos(i));

(async () => {
  { // the least recently used piece goes: its segments come back, the look hears of it, and a run asks for it again
    const src = source({ fresh: { [pos(0)]: answer(inPiece(1, 0)), [pos(1)]: answer(inPiece(2, 1)), [pos(2)]: answer(inPiece(3, 2)), [pos(3)]: answer(inPiece(4, 3)) } });
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: src.fetchStreets, maxSegs: MAX });
    let told = 0;
    s.onWaysChanged = () => told++;
    for (const i of [0, 1, 2]) await s.ensureRects([rect(i)], "run");
    assert.equal(s.segCount, 87);
    const epoch = s.wayEpoch, version = s.version;
    await s.ensureRects([rect(3)], "run");
    assert.deepEqual([0, 1, 2, 3].map((i) => held(s, i)), [false, true, true, true]);
    assert.deepEqual([...s.wayIds].sort(), [2, 3, 4]);
    assert.equal(s.segCount, 87, "piece 0's 29 segments given back before piece 3's came in");
    assert.ok(s.wayEpoch > epoch && s.version > version);
    assert.equal(s.covered(51.01, lon(0, 0.01)), false, "an evicted piece is not held");
    consistent(s);
    await Promise.resolve();
    assert.equal(told, 1, "the Streets in fog look is told to judge its ways again");
    const before = src.asked.length;
    await s.ensureRects([rect(0)], "run");
    assert.deepEqual(src.asked.slice(before), [[pos(0)]], "the evicted piece is missing again");
    consistent(s);
  }
  const four = { [pos(0)]: answer(inPiece(1, 0)), [pos(1)]: answer(inPiece(2, 1)), [pos(2)]: answer(inPiece(3, 2)), [pos(3)]: answer(inPiece(4, 3)), [pos(4)]: answer(inPiece(5, 4)) };
  for (const cacheOnly of [false, true]) { // a run over a held piece uses it, asked for or only read (what the look paints): the next piece goes instead
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: source({ fresh: four }).fetchStreets, maxSegs: MAX });
    for (const i of [0, 1, 2]) await s.ensureRects([rect(i)], "run");
    await s.ensureRects([rect(0)], "run", { cacheOnly });
    await s.ensureRects([rect(3)], "run");
    assert.deepEqual([0, 1, 2, 3].map((i) => held(s, i)), [true, false, true, true], cacheOnly ? "painted" : "asked for");
    consistent(s);
  }
  { // a caller's held pieces stay until its next run; the run reading a piece never drops its own
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: source({ fresh: four }).fetchStreets, maxSegs: MAX });
    await s.ensureRects([rect(0)], "run", { holdAs: "suggest" });
    for (const i of [1, 2, 3]) await s.ensureRects([rect(i)], "run");
    assert.deepEqual([0, 1, 2, 3].map((i) => held(s, i)), [true, false, true, true], "the suggestion's piece is kept, the next oldest goes");
    await s.ensureRects([rect(4)], "run", { holdAs: "suggest" });
    assert.deepEqual([0, 2, 3, 4].map((i) => held(s, i)), [false, true, true, true], "its next run lets the old one go");
    const t = new StreetIndex({ newFrac: () => 1, fetchStreets: source({ fresh: four }).fetchStreets, maxSegs: MAX });
    await t.ensureRects([rect(0), rect(1), rect(2), rect(3)], "run");
    assert.deepEqual([0, 1, 2, 3].map((i) => held(t, i)), [true, true, true, true], "nothing it covers is evicted: the cap cuts in instead");
    consistent(s); consistent(t);
  }
  { // a piece under a run still running is not evicted by another run's read
    let release;
    const gate = new Promise((r) => { release = r; });
    const plain = source({ fresh: four }).fetchStreets;
    const s = new StreetIndex({ newFrac: () => 1, maxSegs: MAX, fetchStreets: async (tiles, kind, onTile, opts) => {
      if (tiles.some((t) => t.x === 548)) { onTile(tiles[0], four[pos(0)]); await gate; return new Map(); }
      return plain(tiles, kind, onTile, opts);
    } });
    const slow = s.ensureRects([rect(0)], "run");
    await Promise.resolve();
    for (const i of [1, 2, 3]) await s.ensureRects([rect(i)], "run");
    assert.deepEqual([0, 1, 2, 3].map((i) => held(s, i)), [true, false, true, true]);
    release();
    await slow;
    consistent(s);
  }
  { // a way two pieces list survives while either holds it, and goes with the second
    const shared = line(9, lon(0, 0.010), lon(1, 0.015)); // 0.030°, 42 segments
    const s = new StreetIndex({ newFrac: () => 1, maxSegs: 80, fetchStreets: source({ fresh: {
      [pos(0)]: answer(shared), [pos(1)]: answer(shared), [pos(2)]: answer(inPiece(3, 2)), [pos(3)]: answer(inPiece(4, 3)), [pos(4)]: answer(inPiece(5, 4)) } }).fetchStreets });
    // a cap of 80 drops past 68 down to 56; piece 1 is read after piece 2, so 0 and then 2 are the oldest
    for (const i of [0, 2, 1, 3]) await s.ensureRects([rect(i)], "run");
    assert.deepEqual([0, 1, 2, 3].map((i) => held(s, i)), [false, true, false, true]);
    assert.ok(s.wayIds.has(9), "piece 1 still lists the shared way");
    assert.equal(s.segCount, 42 + 29);
    await s.ensureRects([rect(4)], "run");
    assert.deepEqual([1, 3, 4].map((i) => held(s, i)), [false, true, true]);
    assert.ok(!s.wayIds.has(9), "no piece lists it any more");
    assert.equal(s.segCount, 29 + 29);
    consistent(s);
  }
  { // a way a fresh piece and an expired copy both list stays with the copy once the fresh piece goes, and a fresh answer for that
    // copy's piece that lacks the way then drops it
    const shared = line(9, lon(0, 0.010), lon(1, 0.015)), own = line(8, lon(1, 0.016), lon(1, 0.023)); // 42 and 10 segments
    // a cap of 90 (drops past 76.5, down to 63) lets the expired copy in before anything is evicted
    const s = new StreetIndex({ newFrac: () => 1, maxSegs: 90, fetchStreets: source({
      fresh: { [pos(0)]: answer(shared), [pos(1)]: answer(own), [pos(2)]: answer(inPiece(3, 2)), [pos(3)]: answer(inPiece(4, 3)) },
      expired: { [pos(1)]: answer(shared, own) } }).fetchStreets });
    await s.ensureRects([rect(0)], "run");
    await s.ensureRects([rect(2)], "run");
    await s.ensureRects([rect(1)], "run", { cacheOnly: true });
    assert.deepEqual([s.segCount, [...s.staleWays.keys()]], [81, [8]], "the expired copy adds only the way no fresh piece holds");
    await s.ensureRects([rect(3)], "run");
    assert.deepEqual([0, 2, 3].map((i) => held(s, i)), [false, false, true]);
    assert.ok(s.staleTiles.has("run:" + pos(1)), "the expired copy's piece is kept");
    assert.deepEqual([...s.staleWays.keys()].sort(), [8, 9], "the shared way is held by the expired copy alone");
    await s.ensureRects([rect(1)], "run");
    assert.ok(!s.wayIds.has(9) && s.wayIds.has(8), "the fresh answer for that piece does not list it");
    assert.equal(s.staleWays.size, 0);
    consistent(s);
  }
  { // piece 0's read evicts piece 1's expired copy and replaces the way they share: once piece 0 is
    // evicted too, nothing lists the way
    const shared = line(9, lon(0, 0.020), lon(1, 0.004));
    const byLat = (id, i, lat) => ({ id, nodes: [id * 10, id * 10 + 1], geometry: [{ lat, lon: lon(i, 0.001) }, { lat, lon: lon(i, 0.012) }] });
    const fresh = { [pos(0)]: answer(shared), [pos(3)]: answer(line(4, lon(3, 0.001), lon(3, 0.024)), byLat(5, 3, 51.015)) };
    for (const i of [2, 4, 5, 6, 7]) fresh[pos(i)] = answer(inPiece(20 + i, i));
    const s = new StreetIndex({ newFrac: () => 1, maxSegs: MAX, fetchStreets: source({
      fresh, expired: { [pos(1)]: answer(shared, line(8, lon(1, 0.006), lon(1, 0.020))) } }).fetchStreets });
    await s.ensureRects([rect(1)], "run", { cacheOnly: true });
    // piece 3 ends past the cap's 85, so piece 0's read evicts the expired piece 1 (and piece 2) first
    for (const i of [2, 3, 0]) await s.ensureRects([rect(i)], "run");
    assert.ok(!s.staleTiles.has("run:" + pos(1)) && s.wayIds.has(9));
    for (const i of [4, 5, 6, 7]) await s.ensureRects([rect(i)], "run");
    assert.equal(held(s, 0), false);
    assert.ok(!s.wayIds.has(9), "no piece held lists the shared way");
    assert.equal(s.staleWays.size, 0);
    consistent(s);
  }
  { // a failed run, and a bad rect, protect nothing afterwards
    const plain = source({ fresh: four }).fetchStreets;
    const s = new StreetIndex({ newFrac: () => 1, maxSegs: MAX, fetchStreets: async (tiles, kind, onTile, opts) => {
      if (tiles.some((t) => t.x === 548) && !(opts && opts.cacheOnly)) throw Object.assign(new Error("offline"), { reason: "offline" });
      return plain(tiles, kind, onTile, opts);
    } });
    await s.ensureRects([rect(1)], "run");
    await assert.rejects(s.ensureRects([rect(0), rect(1)], "run"), (e) => StreetIndex.isDownloadError(e));
    await assert.rejects(s.ensureRects(null, "run"), TypeError);
    for (const i of [2, 3, 4]) await s.ensureRects([rect(i)], "run");
    assert.equal(held(s, 1), false, "the failed run's piece goes like any other");
    consistent(s);
  }
  { // every kind of an evicted piece goes, so none of them reads as known but empty
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: source({ fresh: four }).fetchStreets, maxSegs: MAX });
    await s.ensureRects([rect(0)], "bike");
    await s.ensureRects([rect(0)], "car");
    for (const i of [1, 2, 3]) await s.ensureRects([rect(i)], "run");
    assert.deepEqual([...s.tiles.keys()].filter((k) => k.endsWith(":" + pos(0))), []);
    assert.equal(s.wayIds.has(1), false);
    consistent(s);
  }
  { // a piece that brought no way still goes, and the look still hears of it
    const s = new StreetIndex({ newFrac: () => 1, maxSegs: MAX, fetchStreets: source({ fresh: Object.assign({}, four, { [pos(0)]: answer() }) }).fetchStreets });
    let told = 0;
    s.onWaysChanged = () => told++;
    await s.ensureRects([rect(0)], "run");
    await s.ensureRects([rect(1), rect(2), rect(3)], "run", { holdAs: "suggest" });
    await Promise.resolve();
    const epoch = s.wayEpoch, before = told;
    await s.ensureRects([rect(4)], "run");
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => held(s, i)), [false, true, true, true, true]);
    assert.ok(s.wayEpoch > epoch);
    await Promise.resolve();
    assert.equal(told, before + 1);
    consistent(s);
  }
  console.log("streets-lru.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
