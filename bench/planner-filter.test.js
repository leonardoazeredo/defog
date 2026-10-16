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
console.log("planner-filter.test.js ok");
