// Suggested routes: no elevation unless the coordinates carry it, and the Use hand-off; synthetic data, no network.
//   node bench/handoff.test.js
"use strict";
const assert = require("node:assert/strict");
const { SuggestTool } = require("./lib/load.js");
const { statsFromCoords } = SuggestTool._internals;

{ // local routes have no z: ascent/descent stay undefined so the cards can hide the row
  const s = statsFromCoords([[13.7, 51], [13.71, 51]]);
  assert.equal(s.ascent, undefined);
  assert.equal(s.descent, undefined);
  assert.ok(s.lenM > 600);
}
{ // coordinates with elevation still report it
  const s = statsFromCoords([[13.7, 51, 100], [13.71, 51, 130], [13.72, 51, 110]]);
  assert.equal(s.ascent, 30);
  assert.equal(s.descent, 20);
}
{ // Use hands the editor the pins and the exact geometry, and clears the previews
  const removed = [];
  const tool = Object.create(SuggestTool.prototype);
  const a = { lat: 51, lng: 13.7 }, b = { lat: 51, lng: 13.71 };
  const C = [[13.7, 51], [13.705, 51.001], [13.71, 51]];
  tool.map = { removeLayer: (l) => removed.push(l) };
  tool.lines = [];
  tool.results = [{ adoptWps: [a, b], r: { coords: C } }];
  assert.deepEqual(tool.adopt(0), { wps: [a, b], coords: C });
  assert.deepEqual(tool.results, []);
  assert.equal(tool.adopt(0), null);
}
console.log("handoff.test.js ok");
