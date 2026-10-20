// Given a usable-way predicate, the planner graph holds only ways the travel class may use; synthetic streets, no network.
//   node bench/planner-filter.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { GraphPlanner, StreetIndex } = global;

const KX = 111320 * Math.cos(51 * Math.PI / 180), KY = 110540;
const ll = (x, y) => ({ lat: 51 + y / KY, lon: 13.7 + x / KX });
const streets = new StreetIndex({ newFrac: () => 1 });
streets.ways = [
  { id: 10, nodes: [1, 2], geometry: [ll(0, 0), ll(500, 0)] },
  { id: 11, nodes: [2, 3], geometry: [ll(500, 0), ll(1000, 0)] }
];
streets.classified = new Set([10, 11]);
streets.classIds.bike = new Set([10]);

{ // profile -> usable-way predicate
  const bike = streets.usableFor("trekking");
  assert.equal(bike(10), true);
  assert.equal(bike(11), false);
  assert.equal(streets.usableFor("hiking-mountain")(11), true);
  assert.equal(bike(99), true, "unclassified way counts as usable");
}
{ // the graph skips ways the class can't use, and edges remember their way
  const p = new GraphPlanner(streets, () => 1, streets.usableFor("trekking"));
  p.build();
  assert.equal(p.edges.length, 1);
  assert.equal(p.edges[0].way, 10);
}
{ // one-way tags only bind the classes that travel on wheels
  streets.oneWay = new Set([10]);
  streets.reverseWay = new Set([11]);
  const wheels = streets.onewayFor("trekking");
  assert.equal(wheels(10), 1);
  assert.equal(wheels(11), -1);
  assert.equal(wheels(12), 0);
  assert.equal(streets.onewayFor("hiking-mountain")(10), 0);
  assert.equal(streets.onewayFor("shortest")(10), 0);
}
{ // bikes may ride contraflow where tagged; cars may not
  streets.bikeBoth = new Set([10]);
  assert.equal(streets.onewayFor("trekking")(10), 0);
  assert.equal(streets.onewayFor("fastbike")(10), 0);
  assert.equal(streets.onewayFor("car-fast")(10), 1);
}
{ // motorways are for cars only
  streets.motorway = new Set([12]);
  assert.equal(streets.usableFor("car-fast")(12), true, "car");
  assert.equal(streets.usableFor("hiking-mountain")(12), false, "walk");
  assert.equal(streets.usableFor("trekking")(12), false, "bike");
  assert.equal(streets.usableFor("shortest")(12), false, "direct");
}
{ // distances run in the direction of travel: out along a one-way is finite, back is not
  const ow = { ways: [{ id: 10, nodes: [1, 2], geometry: [{ lat: 51, lon: 13.7 }, { lat: 51, lon: 13.71 }] }] };
  const p = new GraphPlanner(ow, () => 1, undefined, () => 1);
  p.build();
  const [n1, n2] = [0, 1];
  assert.ok(isFinite(p._plain(n1)[n2]), "1 -> 2 along the way");
  assert.ok(!isFinite(p._plain(n2)[n1]), "2 -> 1 against it");
  assert.ok(isFinite(p._plainTo(n2)[n1]), "1 can reach 2");
  assert.ok(!isFinite(p._plainTo(n1)[n2]), "2 cannot reach 1");
}
{ // a later fetch that only adds class or one-way lists (no new ways) still reaches the graph
  const st = new StreetIndex({ newFrac: () => 1 });
  st.ways = [{ id: 10, nodes: [1, 2], geometry: [{ lat: 51, lon: 13.7 }, { lat: 51, lon: 13.71 }] }];
  const p = new GraphPlanner(st, () => 1, st.usableFor("trekking"), st.onewayFor("trekking"));
  p.build();
  assert.equal(p.edges[0].dir, 0);
  st.oneWay.add(10);
  st.version++; // what ensureRects does when a fetch has been read
  p.build();
  assert.equal(p.edges[0].dir, 1);
}
console.log("planner-filter.test.js ok");
