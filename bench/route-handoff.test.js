// RouteTool.setFixedRoute: the editor takes a suggestion's geometry as it is; Leaflet stub, no network.
//   node bench/route-handoff.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
require("../app/src/route.js");
const { RouteTool, L } = global;

const emitted = [];
const tool = new RouteTool(global.fakeMap(), { onChange: (s) => emitted.push(s) });
let recalcs = 0;
tool._recalc = () => { recalcs++; };
const pins = [L.latLng(51, 13.7), L.latLng(51, 13.71)];
const C = [[13.7, 51], [13.705, 51.001], [13.71, 51]];

const stats = { km: 0.7, seconds: 520, ascent: null, descent: null };
tool.setFixedRoute(pins, C, stats);
assert.equal(recalcs, 0, "no routing request for the hand-off");
assert.deepEqual(tool.routeCoords, C);
assert.equal(tool.wps.length, 2);
assert.deepEqual(emitted[emitted.length - 1], { points: 2, ...stats }, "the caller's stats, unchanged");
assert.equal(tool._reqId, 1, "an in-flight reply must not replace the hand-off");

tool._reqId = 0;
tool.setWaypoints(pins);
assert.equal(recalcs, 1, "an ordinary edit still re-routes");
console.log("route-handoff.test.js ok");
