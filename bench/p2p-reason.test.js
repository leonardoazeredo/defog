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
  s.rects.push({ s: 50.9, n: 51.1, w: 13.6, e: 13.8, kind: "run" });
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
  { // Overpass failing is not reported as a connectivity problem
    const s = streetsWith(street);
    s.rects.length = 0;
    s.ensureRects = async () => { throw new Error("overpass HTTP 502"); };
    const r = await run(s, [0, 0], [1000, 0]);
    assert.equal(r.error, true);
    assert.equal(r.reason, "streets-fetch");
    assert.match(r.why, /502/);
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
  { // rail has no tracks in the street map: declined rather than routed on streets
    const r = await run(streetsWith(street), [0, 0], [1000, 0], "rail");
    assert.equal(r.empty, true);
    assert.equal(r.reason, "mode");
  }
  { // one graph per travel class: walk, rail and direct share one, each wheeled class has its own
    const t = new SuggestTool(global.fakeMap(), { fogMap: { tileCount: 0 }, computeGain: () => null, streets: streetsWith(street) });
    assert.equal(t._getPlanner("rail"), t._getPlanner("shortest"));
    assert.equal(t._getPlanner("rail"), t._getPlanner("hiking-mountain"));
    assert.notEqual(t._getPlanner("trekking"), t._getPlanner("fastbike"));
    assert.notEqual(t._getPlanner("trekking"), t._getPlanner("hiking-mountain"));
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
