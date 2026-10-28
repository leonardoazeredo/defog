// An unlisted profile name ("car-fast"), such as a saved route may carry, degrades to a mode that exists
// instead of throwing.
//   node bench/car-removed.test.js
"use strict";
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
require("./lib/load.js");
const { Estimates, StreetIndex, SuggestTool } = global;

const coords = [[13.4, 52.5], [13.41, 52.5]];

{ // no button, no scenario
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", "app", "index.html"), "utf8"), /data-p="car-fast"/);
  assert.ok(!require("./scenarios.js").some((s) => s.profile === "car-fast"));
}
{ // a stale "car-fast" gets the street class and kind of an unlisted mode, never a car's
  assert.equal(StreetIndex.MODE_CLASS["car-fast"], undefined);
  assert.equal(SuggestTool.streetKind("car-fast"), "bike");
  const streets = new StreetIndex({ newFrac: () => 1 });
  streets.motorway = new Set([7]);
  streets.oneWay = new Set([7]);
  assert.equal(streets.usableFor("car-fast")(7), false, "no mode may use a motorway");
  assert.equal(streets.onewayFor("car-fast")(7), 0, "an unlisted mode ignores one-ways");
}
{ // distance and heights still come back; only the time is unknown, as for any mode with no model
  const e = Estimates.estimate(coords, "car-fast", [10, 12]);
  assert.equal(e.seconds, null);
  assert.ok(e.distanceM > 600);
  assert.equal(e.ascentM, 2);
}
console.log("car removed: ok");
