// Fog from activities alone (no Fog of World import): hasFog(), and SuggestTool treating overlay cells as fog.
//   node bench/activity-fog.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { FogMap, lngLatToCell } = global.FogParser;

{ // hasFog: an import or any overlay cell, and back to false after clearOverlay with no import
  const map = new FogMap();
  assert.equal(map.hasFog(), false);
  map.addCells(Int32Array.from([5000, 5000]));
  assert.equal(map.tileCount, 0);
  assert.equal(map.hasFog(), true, "an activity cell alone is fog");
  map.clearOverlay();
  assert.equal(map.hasFog(), false, "no import and no overlay: no fog loaded");
  map.addCells(Int32Array.from([-1, 0]));
  assert.equal(map.hasFog(), false, "a skipped cell is not fog");
}

{ // _newness: with only overlay cells it reads the fog, so a visited spot scores below 1
  const map = new FogMap();
  const ll = { lat: 52.0, lng: 4.0 };
  const c = lngLatToCell(ll.lng, ll.lat);
  const cells = [];
  for (let dx = -15; dx <= 15; dx++) for (let dy = -15; dy <= 15; dy++) cells.push(Math.floor(c.cx) + dx, Math.floor(c.cy) + dy);
  map.addCells(Int32Array.from(cells));
  const tool = new global.SuggestTool({}, { fogMap: map, computeGain: () => null, streets: {} });
  assert.ok(tool._newness(ll) < 1, "overlay-only fog counts in _newness");
}
console.log("activity-fog.test.js ok");
