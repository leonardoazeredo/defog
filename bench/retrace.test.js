// Pure-logic checks for the retraced share (overlapFrac) and rankKey; no network, no fog.
//   node bench/retrace.test.js
"use strict";
const assert = require("node:assert/strict");
const { SuggestTool } = require("./lib/load.js");
const { overlapFrac, rankKey, RETRACE_WEIGHT, statsFromCoords } = SuggestTool._internals;

const LAT = 51, KY = 111320, KX = 111320 * Math.cos(LAT * Math.PI / 180);
// polyline through metre offsets (east, north) from a fixed origin, a point every ~10 m
function line(...pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 10));
    for (let k = i === 1 ? 0 : 1; k <= n; k++)
      out.push([13.7 + (x0 + (x1 - x0) * k / n) / KX, LAT + (y0 + (y1 - y0) * k / n) / KY, 0]);
  }
  return out;
}

{ // out and back along one street
  const f = overlapFrac(line([0, 0], [1000, 0], [0, 0]), false);
  assert.ok(f > 0.8, `out-and-back ${f}`);
}
{ // one-way routes retrace nothing
  assert.equal(overlapFrac(line([0, 0], [1000, 0]), false), 0);
  assert.ok(overlapFrac(line([0, 0], [500, 0], [500, 500]), false) < 0.05);
}
{ // default stays circular: a closed square loop is not a retrace
  assert.ok(overlapFrac(line([0, 0], [250, 0], [250, 250], [0, 250], [0, 0])) < 0.05);
}
{ // A and B about 28 m apart: closing the gap is not retracing
  const f = overlapFrac(line([0, 0], [500, 0], [500, 500], [20, 500], [20, 20]), false);
  assert.ok(f < 0.15, `nearly closed ${f}`);
}
{ // ranking
  assert.equal(RETRACE_WEIGHT, 0.5);
  assert.equal(rankKey({ area: 1000, newPct: 100 }, 0), 1000);
  assert.equal(rankKey({ area: 1000, newPct: 100 }, 1), 500);
  assert.ok(rankKey({ area: 1000, newPct: 60 }, 0.1) > rankKey({ area: 1000, newPct: 60 }, 0.4));
}
{ // guard against quadratic blow-up; 250 ms is generous for 3000 points on a laptop
  const zig = [];
  for (let i = 0; i < 3000; i++) zig.push([13.7 + (i * 4) / KX, LAT + ((i % 2) * 30 + Math.floor(i / 100) * 40) / KY, 0]);
  const t = Date.now();
  overlapFrac(zig, false);
  assert.ok(Date.now() - t < 250, `overlapFrac took ${Date.now() - t} ms`);
}
(async () => {
{ // _rerouteReturn: the outbound edges are avoided, the result is outbound + new way home; null when there is nothing new
  const out = line([0, 0], [1000, 0]), back = line([1000, 0], [0, 0]);
  const route = Object.assign(statsFromCoords(out.concat(back.slice(1))), {
    legs: [{ coords: out, edges: [1, 2] }, { coords: back, edges: [2, 1] }]
  });
  const via = { lat: LAT, lng: 13.7 + 1000 / KX };
  const Bll = { lat: LAT, lng: 13.7 };
  const homeStreet = line([1000, 0], [1000, 300], [0, 300], [0, 0]);
  const calls = [];
  const tool = Object.create(SuggestTool.prototype);
  tool._route = async (pts, profile, opts) => { calls.push({ pts, opts }); return opts.avoid.size ? { coords: homeStreet } : { coords: back }; };
  const r = await tool._rerouteReturn(route, via, Bll, "trekking");
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0].opts.avoid].sort(), [1, 2]);
  assert.deepEqual(calls[0].pts, [via, Bll]);
  assert.deepEqual(r.coords[0], route.coords[0]);
  assert.deepEqual(r.coords[r.coords.length - 1], homeStreet[homeStreet.length - 1]);
  assert.equal(r.lenM, statsFromCoords(out.concat(homeStreet.slice(1))).lenM);
  tool._route = async () => null;
  assert.equal(await tool._rerouteReturn(route, via, Bll, "trekking"), null);
  tool._route = async () => ({ coords: back }); // same way home again
  assert.equal(await tool._rerouteReturn(route, via, Bll, "trekking"), null);
  tool._route = async () => { throw new Error("must not be called"); };
  assert.equal(await tool._rerouteReturn(Object.assign({}, route, { legs: [route.legs[0]] }), via, Bll, "trekking"), null);
}
console.log("retrace.test.js ok");
})();
