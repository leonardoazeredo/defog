// StreetIndex: a fresh answer for a tile drawn from an expired copy replaces the ways that copy brought; synthetic streets, no network.
//   node bench/streets-refresh.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { GraphPlanner, StreetIndex } = global;

// tile 548:2040 is lon 13.7-13.725, lat 51.0-51.025; 549:2040 is the next one east
const KX = 111320 * Math.cos(51 * Math.PI / 180), KY = 110540;
const ll = (x, y) => ({ lat: 51 + y / KY, lon: 13.7 + x / KX });
const at = (x, y) => ({ lat: 51 + y / KY, lng: 13.7 + x / KX });
const west = { s: 51, w: 13.7, n: 51.025, e: 13.725 }, east = { s: 51, w: 13.725, n: 51.025, e: 13.75 };
const both = { s: 51, w: 13.7, n: 51.025, e: 13.75 };
const way = (id, nodes, ...pts) => ({ id, nodes, geometry: pts.map(([x, y]) => ll(x, y)) });
const answer = (ways, groups) => ({ ways, groups: groups || {} });

// A source holding `expired` copies (handed over in the Map alone on a cache-only read) and answering
// a normal run from `fresh`; both are "x:y" -> answer.
function source(expired, fresh) {
  return async (tiles, kind, onTile, opts) => {
    const out = new Map();
    for (const t of tiles) {
      const k = t.x + ":" + t.y;
      if (opts && opts.cacheOnly) { if (expired[k]) out.set(k, expired[k]); continue; }
      out.set(k, fresh[k]);
      onTile(t, fresh[k]);
    }
    return out;
  };
}
const index = (expired, fresh) => new StreetIndex({ newFrac: () => 1, fetchStreets: source(expired, fresh) });
const segList = (s) => [...s.segs.values()].flat();
const planner = (s, profile = "hiking-mountain") => { const p = new GraphPlanner(s, () => 1, s.usableFor(profile), s.onewayFor(profile)); p.build(); return p; };
const edgeWays = (p) => [...new Set(p.edges.map((e) => e.way))].sort();
const wayIdsOf = (s) => s.ways.map((w) => w.id).sort();
// the index holds exactly what its ways say: every segment counted belongs to a way held
const consistent = (s) => {
  assert.equal(s.segCount, segList(s).length, "segCount counts the segments held");
  assert.deepEqual([...s.wayIds].sort(), wayIdsOf(s), "wayIds names the ways held");
};

(async () => {
  { // an expired copy, then the fresh answer: the way's geometry, classes and one-way flags are the fresh ones everywhere
    const G = [[0, 100], [400, 100]], G2 = [[0, 300], [200, 300], [400, 300]];
    const s = index(
      { "548:2040": answer([way(1, [1, 2], ...G)], { bike: [1], oneWay: [1], bikeBoth: [1] }) },
      { "548:2040": answer([way(1, [1, 3, 2], ...G2)], { road: [1], reverseWay: [1] }) });
    await s.ensureRects([west], "run", { cacheOnly: true });
    const before = planner(s);
    assert.deepEqual(before.edges.map((e) => e.coords), [G.map(([x, y]) => [ll(x, y).lon, ll(x, y).lat])]);
    assert.equal(s.usableFor("trekking")(1), true, "bike class from the expired copy");
    assert.equal(s.onewayFor("trekking")(1), 0, "bikeBoth from the expired copy frees it");
    assert.equal(segList(s).length, 8);
    const v = s.version;

    await s.ensureRects([west], "run");
    assert.ok(s.version > v);
    assert.deepEqual(s.ways, [{ id: 1, nodes: [1, 3, 2], geometry: G2.map(([x, y]) => ll(x, y)) }], "only the fresh way is held");
    assert.equal(s.usableFor("trekking")(1), false, "not a bike way any more");
    assert.equal(s.usableFor("fastbike")(1), true, "but a road bike's");
    assert.deepEqual([s.onewayFor("fastbike")(1), s.oneWay.has(1), s.bikeBoth.has(1)], [-1, false, false], "fresh one-way flags only");
    const segs = segList(s);
    assert.equal(segs.length, 8, "400 m in 8 segments of 50 m, the old 8 are gone");
    assert.ok(segs.every((g) => Math.abs(g.lat - (51 + 300 / KY)) < 1e-9), "every segment lies on the fresh geometry");
    assert.equal(s.newAreaM2(at(200, 100), 100), 0, "nothing scored on the old line");
    assert.ok(s.newAreaM2(at(200, 300), 100) > 0, "scored on the new one");
    consistent(s);
    const after = planner(s);
    assert.notEqual(after.builtStamp, before.builtStamp);
    await s.ensureRects([west], "run");
    assert.equal(after.builtStamp, planner(s).builtStamp, "a covered tile is not read again");
    assert.deepEqual(after.edges.map((e) => [e.way, e.coords.length]), [[1, 3]]);
    assert.equal(s.staleWays.size, 0);
  }
  { // a planner built on the expired copy rebuilds after the fresh answer, though the number of ways is the same
    const s = index({ "548:2040": answer([way(1, [1, 2], [0, 100], [400, 100])]) }, { "548:2040": answer([way(1, [1, 2], [0, 300], [400, 300])]) });
    await s.ensureRects([west], "run", { cacheOnly: true });
    const p = planner(s);
    const stamp = p.builtStamp, lat0 = p.edges[0].coords[0][1];
    await s.ensureRects([west], "run");
    p.build();
    assert.notEqual(p.builtStamp, stamp);
    assert.notEqual(p.edges[0].coords[0][1], lat0);
    assert.ok(Math.abs(p.edges[0].coords[0][1] - (51 + 300 / KY)) < 1e-9);
  }
  { // a way the fresh answer no longer has is gone, with its segments, classes and graph edges
    const s = index(
      { "548:2040": answer([way(1, [1, 2], [0, 100], [400, 100]), way(2, [3, 4], [0, 200], [250, 200])], { bike: [1, 2], oneWay: [1], bikeBoth: [1], reverseWay: [2] }) },
      { "548:2040": answer([way(2, [3, 4], [0, 200], [250, 200])], { bike: [2], reverseWay: [2] }) });
    await s.ensureRects([west], "run", { cacheOnly: true });
    assert.deepEqual(edgeWays(planner(s, "trekking")), [1, 2]);
    await s.ensureRects([west], "run");
    assert.deepEqual(wayIdsOf(s), [2]);
    for (const set of [s.wayIds, s.classified, s.classIds.bike, s.oneWay, s.motorway, s.bikeBoth]) assert.equal(set.has(1), false);
    assert.equal(s.classIds.bike.has(2), true);
    assert.equal(segList(s).length, 5, "only way 2's 250 m remain");
    assert.deepEqual(edgeWays(planner(s, "trekking")), [2]);
    consistent(s);
  }
  { // a way across two tiles, only one refreshed: it stays while the other tile's expired copy still lists it, and is held once
    const across = (y) => way(7, [70, 71], [200, y], [1900, y]); // lon 13.7 + 1900 m crosses into tile 549
    const s = index(
      { "548:2040": answer([across(100), way(1, [1, 2], [0, 500], [100, 500])], { bike: [7, 1] }), "549:2040": answer([across(100), way(2, [3, 4], [1500, 500], [1700, 500])], { bike: [7, 2] }) },
      { "548:2040": answer([way(1, [1, 2], [0, 500], [100, 500])], { bike: [1] }), "549:2040": answer([across(300), way(2, [3, 4], [1500, 500], [1700, 500])], { bike: [7, 2], oneWay: [7] }) });
    await s.ensureRects([both], "run", { cacheOnly: true });
    assert.deepEqual(wayIdsOf(s), [1, 2, 7], "the shared way is held once");
    const total = s.segCount;
    consistent(s);

    await s.ensureRects([west], "run");
    assert.deepEqual(wayIdsOf(s), [1, 2, 7], "the west tile no longer lists it, the east copy still does");
    assert.equal(s.segCount, total);
    assert.ok(s.ways.find((w) => w.id === 7).geometry[0].lat < 51 + 200 / KY, "still the expired copy's geometry");
    assert.equal(s.classIds.bike.has(7), true);
    consistent(s);

    await s.ensureRects([east], "run");
    const seven = s.ways.filter((w) => w.id === 7);
    assert.equal(seven.length, 1, "replaced, not duplicated");
    assert.ok(Math.abs(seven[0].geometry[0].lat - (51 + 300 / KY)) < 1e-9, "the fresh geometry");
    assert.deepEqual([s.oneWay.has(7), s.classIds.bike.has(7)], [true, true]);
    assert.equal(segList(s).filter((g) => Math.abs(g.lat - (51 + 100 / KY)) < 1e-9).length, 0, "no segment of the old line");
    assert.deepEqual(edgeWays(planner(s)), [1, 2, 7]);
    consistent(s);
  }
  { // both tiles drop it: gone only when the last tile that brought it is refreshed
    const across = way(7, [70, 71], [200, 100], [1900, 100]);
    const s = index({ "548:2040": answer([across], { bike: [7] }), "549:2040": answer([across], { bike: [7] }) }, { "548:2040": answer([]), "549:2040": answer([]) });
    await s.ensureRects([both], "run", { cacheOnly: true });
    await s.ensureRects([west], "run");
    assert.deepEqual(wayIdsOf(s), [7]);
    await s.ensureRects([east], "run");
    assert.deepEqual(wayIdsOf(s), [], "no held tile brings it any more");
    assert.deepEqual([s.segCount, s.classIds.bike.size, segList(s).length, s.staleWays.size], [0, 0, 0, 0]);
  }
  { // a way a fresh tile holds is not replaced from an expired copy read later
    const fresh = way(7, [70, 71], [200, 100], [1900, 100]);
    const old = way(7, [70, 71], [200, 900], [1900, 900]);
    const s = index({ "549:2040": answer([old], { oneWay: [7] }) }, { "548:2040": answer([fresh], { bike: [7] }) });
    await s.ensureRects([west], "run");
    await s.ensureRects([east], "run", { cacheOnly: true });
    assert.equal(s.ways.length, 1);
    assert.ok(Math.abs(s.ways[0].geometry[0].lat - (51 + 100 / KY)) < 1e-9, "the fresh copy stays");
    assert.equal(s.oneWay.has(7), false, "the expired copy adds none of its classes to it");
    assert.equal(s.staleWays.size, 0);
  }
  { // a way two fresh tiles list is held once, and no expired copy is tracked
    const s = index({}, { "548:2040": answer([way(1, [1, 2], [0, 100], [400, 100]), way(7, [70, 71], [200, 100], [1900, 100])], { bike: [1, 7] }), "549:2040": answer([way(7, [70, 71], [200, 100], [1900, 100])], { bike: [7] }) });
    await s.ensureRects([both], "run");
    assert.deepEqual(wayIdsOf(s), [1, 7]);
    assert.deepEqual([s.staleWays.size, s.wayEpoch], [0, 0]);
    consistent(s);
  }
  { // a fresh bike answer replaces the way an expired run copy listed, and keeps the footway, which a bike answer never lists
    const s = index(
      { "548:2040": answer([way(1, [1, 2], [0, 100], [400, 100]), way(3, [5, 6], [0, 200], [300, 200])], { bike: [1] }) },
      { "548:2040": answer([way(1, [1, 2], [0, 300], [400, 300])], { bike: [1] }) });
    await s.ensureRects([west], "run", { cacheOnly: true });
    await s.ensureRects([west], "bike");
    assert.deepEqual(wayIdsOf(s), [1, 3], "the footway (run only) is not dropped by a bike answer");
    assert.ok(Math.abs(s.ways.find((w) => w.id === 1).geometry[0].lat - (51 + 300 / KY)) < 1e-9);
    consistent(s);
    const t = index({ "548:2040": answer([way(3, [5, 6], [0, 200], [300, 200])]) }, { "548:2040": answer([]) });
    await t.ensureRects([west], "run", { cacheOnly: true });
    await t.ensureRects([west], "run");
    assert.deepEqual(wayIdsOf(t), [], "a run answer covers what a run copy brought");
  }
  { // the segment cap: a way the fresh answer drops gives its segments back
    // ~224k segments per edge, and the cap is checked before each edge, so the edge that crosses it is added whole (448k against 400k); the third edge is not added
    const long = (id) => way(id, [id, id + 1, id + 2, id + 3], [-5600000, 100], [5600000, 100], [-5600000, 200], [5600000, 200]);
    const s = index({ "548:2040": answer([long(1)]) }, { "548:2040": answer([way(2, [9, 10], [0, 100], [400, 100])]) });
    await s.ensureRects([west], "run", { cacheOnly: true });
    assert.ok(s.segCount >= 400000 && s.segCount < 500000, "capped after two edges");
    await s.ensureRects([west], "run");
    assert.equal(s.segCount, 8, "the capped way's segments are all given back");
    consistent(s);
  }
  { // an expired bike copy is replaced by a fresh run answer; a bike answer does not drop what a run copy brought
    const bike = index({ "548:2040": answer([way(1, [1, 2], [0, 100], [400, 100])]) }, { "548:2040": answer([]) });
    await bike.ensureRects([west], "bike", { cacheOnly: true });
    await bike.ensureRects([west], "run");
    assert.deepEqual(wayIdsOf(bike), [], "a run answer covers what a bike copy brought");
    const run = index({ "548:2040": answer([way(3, [5, 6], [0, 200], [300, 200])]) }, { "548:2040": answer([]) });
    await run.ensureRects([west], "run", { cacheOnly: true });
    await run.ensureRects([west], "bike");
    assert.deepEqual(wayIdsOf(run), [3], "a bike answer never lists a footway");
    consistent(bike); consistent(run);
  }
  { // an expired copy that reaches the index after a run covered the tile adds nothing: nothing would ask for the tile again
    let release;
    const gate = new Promise((r) => { release = r; });
    const fresh = answer([way(1, [1, 2], [0, 300], [400, 300])]), old = answer([way(1, [1, 2], [0, 100], [400, 100]), way(5, [5, 6], [0, 500], [300, 500])]);
    const s = new StreetIndex({
      newFrac: () => 1,
      fetchStreets: async (tiles, kind, onTile, opts) => {
        const out = new Map();
        for (const t of tiles) {
          if (opts && opts.cacheOnly) { await gate; out.set(t.x + ":" + t.y, old); } else onTile(t, fresh);
        }
        return out;
      },
    });
    const drawing = s.ensureRects([west], "run", { cacheOnly: true });
    await s.ensureRects([west], "run");
    release();
    await drawing;
    assert.deepEqual(wayIdsOf(s), [1]);
    assert.ok(Math.abs(s.ways[0].geometry[0].lat - (51 + 300 / KY)) < 1e-9, "the fresh geometry");
    assert.equal(s.staleWays.size, 0);
    consistent(s);
  }
  { // an expired copy that cannot be read whole leaves nothing the fresh answer cannot replace
    const bad = { id: 1, nodes: [1, 2], geometry: [ll(0, 100), null] };
    const s = index({ "548:2040": answer([bad]) }, { "548:2040": answer([way(1, [1, 2], [0, 300], [400, 300])]) });
    const v = s.version;
    await assert.rejects(s.ensureRects([west], "run", { cacheOnly: true }), TypeError);
    assert.ok(s.version > v, "graphs built before still rebuild");
    await s.ensureRects([west], "run");
    assert.deepEqual(s.ways, [{ id: 1, nodes: [1, 2], geometry: [ll(0, 300), ll(400, 300)] }]);
    consistent(s);
  }
  { // a fresh piece dropped a way: an expired copy of another piece, read later, does not bring it back,
    // and a fresh answer listing it again does
    const W = [[100, 100], [300, 100]];
    const s = index(
      { "548:2040": answer([way(1, [1, 2], ...W)], { road: [1] }), "549:2040": answer([way(1, [1, 2], ...W)], { road: [1] }) },
      { "548:2040": answer([]), "549:2040": answer([way(1, [1, 2], ...W)], { bike: [1] }) });
    await s.ensureRects([west], "run", { cacheOnly: true });
    assert.deepEqual(wayIdsOf(s), [1]);
    await s.ensureRects([west], "run");
    assert.deepEqual(wayIdsOf(s), [], "the fresh piece lacks it");
    await s.ensureRects([east], "run", { cacheOnly: true });
    assert.deepEqual(wayIdsOf(s), [], "an older copy read later does not bring it back");
    assert.equal(s.classIds.road.has(1), false, "nor its classes");
    consistent(s);
    await s.ensureRects([east], "run");
    assert.deepEqual(wayIdsOf(s), [1], "a fresh answer that lists it brings it back");
    assert.equal(s.usableFor("trekking")(1), true);
    consistent(s);
  }
  { // what a bike answer drops says nothing about a run copy's footways
    const W = [[100, 100], [300, 100]];
    const s = index(
      { "548:2040": answer([way(1, [1, 2], ...W)]), "549:2040": answer([way(1, [1, 2], ...W)]) },
      { "548:2040": answer([]) });
    await s.ensureRects([west], "bike", { cacheOnly: true });
    await s.ensureRects([west], "bike");
    assert.deepEqual(wayIdsOf(s), [], "the fresh bike piece lacks it");
    await s.ensureRects([east], "run", { cacheOnly: true });
    assert.deepEqual(wayIdsOf(s), [1], "an expired run copy still brings a way a bike answer dropped");
    consistent(s);
  }
  { // a listener that throws is logged by class, never left to an unhandled rejection
    const W = [[100, 100], [300, 100]];
    const s = index({ "548:2040": answer([way(1, [1, 2], ...W)]) }, { "548:2040": answer([]) });
    await s.ensureRects([west], "run", { cacheOnly: true });
    const logged = [], error = console.error;
    console.error = (...a) => logged.push(a);
    s.onWaysChanged = () => { throw new RangeError("listener"); };
    try {
      await s.ensureRects([west], "run");
      // the listener runs a few microtasks after the run resolves
      for (let i = 0; i < 5; i++) await Promise.resolve();
    } finally { console.error = error; }
    assert.ok(logged.length > 0, "the throw is logged");
    for (const a of logged) assert.deepEqual(a, ["[streets] onWaysChanged threw", "RangeError"]);
  }
  console.log("streets-refresh.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
