// A suggestion run that cannot route says why; synthetic streets, no network.
//   node bench/p2p-reason.test.js
"use strict";
const assert = require("node:assert/strict");
const { SuggestTool, StreetIndex } = require("./lib/load.js");

const KX = 111320 * Math.cos(51 * Math.PI / 180), KY = 110540;
const ll = (x, y) => ({ lat: 51 + y / KY, lon: 13.7 + x / KX });
const pin = (x, y) => { const p = global.L.latLng(51 + y / KY, 13.7 + x / KX); return { getLatLng: () => p }; };

// ways: [id, [nodeA, nodeB], [x, y], [x, y]]; the whole area counts as already fetched
function streetsWith(ways) {
  const s = new StreetIndex({ newFrac: () => 1 });
  s._anchor(51);
  for (const [id, nodes, p, q] of ways) s._addWay({ id, nodes, geometry: [ll(...p), ll(...q)] });
  s._cover(StreetIndex.tilesCovering({ s: 50.9, n: 51.1, w: 13.6, e: 13.8 }), "run");
  return s;
}
async function run(streets, a, b, profile = "hiking-mountain") {
  const tool = new SuggestTool(global.fakeMap(), { fogMap: { tileCount: 0 }, computeGain: () => null, streets });
  tool.mode = "p2p"; tool.a = pin(...a); tool.b = pin(...b);
  let last = null;
  tool.onResults = (s) => { if (s && !s.loading) last = s; };
  await tool.suggest(profile, { buffer: 0.15 });
  return last;
}
const street = [[1, [1, 2], [0, 0], [500, 0]], [2, [2, 3], [500, 0], [1000, 0]]];

(async () => {
  { // a failed download passes on its reason, counts and retry time, and none of its text
    const s = streetsWith(street);
    s.tiles.clear();
    const remark = "runtime error: Query timed out in \"query\" at line 3 after 61 seconds.";
    const cause = Object.assign(new Error("overpass: " + remark), { reason: "busy", retryAt: 12345 });
    s.ensureRects = async () => { throw StreetIndex.downloadError(2, 5, cause); };
    const logged = [], orig = console.warn;
    console.warn = (...a) => logged.push(a);
    const r = await run(s, [0, 0], [1000, 0]);
    console.warn = orig;
    assert.deepEqual(logged, [["[suggest] streets unavailable", "streets-partial"]], "the log holds the reason only");
    assert.equal(r.error, true);
    assert.equal(r.reason, "streets-fetch");
    assert.deepEqual(r.download, { reason: "streets-partial", done: 2, total: 5, retryAt: 12345, cause: { reason: "busy" } });
    assert.ok(!JSON.stringify(r).includes("timed out"), "no server text in the result");
  }
  { // the download's progress is emitted while the tiles come in, and stops when they are in
    const states = [];
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles, kind, onTile) => {
      for (const t of tiles) onTile(t, { ways: [], groups: {} });
      return new Map();
    } });
    const tool = new SuggestTool(global.fakeMap(), { fogMap: { tileCount: 0 }, computeGain: () => null, streets: s });
    tool.mode = "p2p"; tool.a = pin(0, 0); tool.b = pin(1000, 0);
    tool.onResults = (st) => states.push(st);
    await tool.suggest("hiking-mountain", { buffer: 0.15 });
    const dl = states.filter((st) => st && st.phase === "streets");
    assert.ok(dl.length >= 2);
    const total = dl[0].total;
    assert.deepEqual(dl.map((st) => st.done), Array.from({ length: total + 1 }, (_, i) => i), "0 of N up to N of N");
    assert.ok(dl.every((st) => st.loading && st.total === total));
    assert.equal(states[states.length - 1].reason, "no-street-data", "an area with no streets still ends in its own state");
  }
  { // fetched, but nothing usable in the area
    const r = await run(streetsWith([]), [0, 0], [1000, 0]);
    assert.equal(r.reason, "no-street-data");
  }
  { // B nowhere near a street
    const r = await run(streetsWith(street), [0, 0], [0, 5000]);
    assert.equal(r.reason, "off-network");
    assert.equal(r.why.point, 1);
  }
  { // both on streets, but not the same piece of the map
    const r = await run(streetsWith(street.concat([[3, [7, 8], [0, 300], [250, 300]], [4, [8, 9], [250, 300], [500, 300]]])), [0, 0], [500, 300]);
    assert.equal(r.reason, "no-path");
    assert.ok(Math.abs(r.why.gap.m - 300) < 5);
  }
  { // two pins farther apart than the street download can cover: declined before downloading
    const st = streetsWith(street);
    st.ensureRects = async () => { throw new Error("must not download"); };
    const r = await run(st, [0, 0], [0, 40000]);
    assert.equal(r.empty, true);
    assert.equal(r.reason, "too-far");
  }
  { // one graph per travel class: walk and shortest share one, each wheeled class has its own
    const t = new SuggestTool(global.fakeMap(), { fogMap: { tileCount: 0 }, computeGain: () => null, streets: streetsWith(street) });
    assert.equal(t.plannerFor("shortest"), t.plannerFor("hiking-mountain"));
    assert.notEqual(t.plannerFor("trekking"), t.plannerFor("fastbike"));
    assert.notEqual(t.plannerFor("trekking"), t.plannerFor("hiking-mountain"));
  }
  { // a loop longer than the street download can cover says so, without downloading anything
    const st = streetsWith(street);
    st.ensureRects = async () => { throw new Error("must not download"); };
    const tool = new SuggestTool(global.fakeMap(), { fogMap: { tileCount: 0 }, computeGain: () => null, streets: st });
    tool.mode = "loop"; tool.a = pin(0, 0);
    let last = null;
    tool.onResults = (x) => { if (x && !x.loading) last = x; };
    await tool.suggest("hiking-mountain", { distM: 50000, buffer: 0.15 });
    assert.equal(last.empty, true);
    assert.equal(last.reason, "too-long");
  }
  console.log("p2p-reason.test.js ok");
})();
