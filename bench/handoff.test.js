// Suggested routes: no elevation unless the coordinates carry it, and the Use hand-off; synthetic data, no network.
//   node bench/handoff.test.js
"use strict";
const assert = require("node:assert/strict");
const { SuggestTool } = require("./lib/load.js");
const { statsFromCoords, joinPins } = SuggestTool._internals;

{ // local routes have no z: ascent/descent stay undefined so the cards can hide the row
  const s = statsFromCoords([[13.7, 51], [13.71, 51]]);
  assert.equal(s.ascent, undefined);
  assert.equal(s.descent, undefined);
  assert.ok(s.lenM > 600);
}
{ // coordinates with elevation report the filtered climb: a 20 m drop after a 30 m rise counts 10 m,
  // because the first 10 m of a drop sit inside the 10 m buffer; the length stays the plain sum
  const flat = statsFromCoords([[13.7, 51], [13.71, 51], [13.72, 51]]);
  const s = statsFromCoords([[13.7, 51, 100], [13.71, 51, 130], [13.72, 51, 110]]);
  assert.equal(s.ascent, 30);
  assert.equal(s.descent, 10);
  assert.equal(s.lenM, flat.lenM);
}
{ // the first rise counts at once; the dip is held back and the second rise pays it off, so the wobble adds one rise, not two
  const s = statsFromCoords([[13.7, 51, 100], [13.71, 51, 104], [13.72, 51, 100], [13.73, 51, 104]]);
  assert.equal(s.ascent, 4);
  assert.equal(s.descent, 0);
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
{ // the editor's pins sit where the route joins its legs, not on the via pin that may be off the street
  const a = { lat: 51, lng: 13.7 }, b = { lat: 51.01, lng: 13.72 };
  const r = { legs: [{ coords: [[13.7, 51], [13.71, 51.001]] }, { coords: [[13.71, 51.001], [13.72, 51.01]] }] };
  const pins = joinPins(r, a, b);
  assert.equal(pins.length, 3);
  assert.deepEqual([pins[1].lat, pins[1].lng], [51.001, 13.71]);
  assert.equal(pins[0], a);
  assert.equal(pins[2], b);
}
console.log("handoff.test.js ok");
