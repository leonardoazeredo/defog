// LocalRouter: shortest paths over the planner's street graph; synthetic streets, no network.
//   node bench/router.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { GraphPlanner, LocalRouter } = global;

const KX = 111320 * Math.cos(51 * Math.PI / 180), KY = 110540;
const ll = (x, y) => ({ lat: 51 + y / KY, lon: 13.7 + x / KX });
const pt = (x, y) => ({ lat: 51 + y / KY, lng: 13.7 + x / KX });
// streets of straight two-node ways: [idA, idB, [x, y], [x, y]]
function router(ways) {
  const streets = { ways: ways.map(([a, b, p, q], i) => ({ id: 100 + i, nodes: [a, b], geometry: [ll(...p), ll(...q)] })) };
  return new LocalRouter(new GraphPlanner(streets, () => 1));
}
// straight street 1-2-3 along y=0 (1000 m); parallel street 1-4-5-3 at y=200 (1400 m with the joins)
const straight = [[1, 2, [0, 0], [500, 0]], [2, 3, [500, 0], [1000, 0]]];
const parallel = [[1, 4, [0, 0], [0, 200]], [4, 5, [0, 200], [1000, 200]], [5, 3, [1000, 200], [1000, 0]]];
const A = pt(0, 0), B = pt(1000, 0);

{ // straight street: exact end points, one leg, shortest length
  const r = router(straight).route([A, B]);
  assert.ok(Math.abs(r.lenM - 1000) < 1, `len ${r.lenM}`);
  assert.deepEqual(r.coords[0], [A.lng, A.lat]);
  assert.deepEqual(r.coords[r.coords.length - 1], [B.lng, B.lat]);
  assert.equal(r.legs.length, 1);
}
{ // avoided edges are a penalty: the route takes the parallel street instead
  const rt = router(straight.concat(parallel));
  const first = rt.route([A, B]);
  const second = rt.route([A, B], { avoid: new Set(first.legs[0].edges) });
  assert.ok(Math.abs(second.lenM - 1400) < 5, `len ${second.lenM}`);
}
{ // a via splits the route into legs that join without a repeated vertex
  const r = router(straight).route([A, pt(500, 0), B]);
  assert.equal(r.legs.length, 2);
  assert.deepEqual(r.coords, r.legs[0].coords.concat(r.legs[1].coords.slice(1)));
}
{ // no street within reach of a point, or no path between the points: null, not a throw
  assert.equal(router(straight).route([A, pt(0, 5000)]), null);
  const islands = straight.concat([[7, 8, [0, 3000], [500, 3000]]]);
  assert.equal(router(islands).route([A, pt(500, 3000)]), null);
  assert.equal(router(straight).route([A]), null);
}
{ // a start beside a dead end still routes (the planner's nearestNode would skip it)
  const r = router(straight.concat([[6, 2, [500, 400], [500, 0]]])).route([pt(500, 380), B]);
  assert.ok(r, "dead-end start");
  assert.ok(Math.abs(r.lenM - (400 + 500)) < 25, `len ${r.lenM}`);
}
{ // a fragment of the street map nearer than the real network is not a start: snap to the network
  const chain = [];
  for (let i = 0; i < 60; i++) chain.push([i + 1, i + 2, [i * 20, 0], [(i + 1) * 20, 0]]);
  const courtyard = [[900, 901, [228, 6], [236, 6]]];
  const rt = router(chain.concat(courtyard));
  const r = rt.route([pt(232, 4), pt(1180, 0)]);
  assert.ok(r, "start beside a stray fragment");
  assert.ok(Math.abs(r.lenM - 950) < 30, `len ${r.lenM}`); // ~(240,0) along the chain to (1180,0)
  const alone = router(courtyard); // nothing bigger around: the fragment is all there is
  assert.ok(alone.route([pt(228, 6), pt(236, 6)]));
}
{ // explain: a routable pair reports no failure and the snap it used
  const e = router(straight).explain([A, B]);
  assert.equal(e.reason, null);
  assert.ok(e.points[0].snapM < 1 && e.points[1].snapM < 1);
  assert.equal(e.graph.edges, 2);
}
{ // explain: separate pieces of the map name the failure and the closest approach
  const e = router(straight.concat([[7, 8, [0, 300], [250, 300]], [8, 9, [250, 300], [500, 300]]])).explain([A, pt(500, 300)]);
  assert.equal(e.reason, "no-path");
  assert.notEqual(e.points[0].piece, e.points[1].piece);
  assert.ok(Math.abs(e.gap.m - 300) < 5, `gap ${e.gap && e.gap.m}`);
  assert.equal(e.graph.pieces, 2);
}
{ // explain: a point off the network says which one and how far the nearest street is
  const e = router(straight).explain([A, pt(0, 5000)]);
  assert.equal(e.reason, "off-network");
  assert.equal(e.point, 1);
  assert.ok(Math.abs(e.points[1].nearestM - 5000) < 50, `nearest ${e.points[1].nearestM}`);
}
console.log("router.test.js ok");
