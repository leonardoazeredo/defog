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

tool.setFixedRoute(pins, C);
assert.equal(recalcs, 0, "no routing request for the hand-off");
assert.deepEqual(tool.routeCoords, C);
assert.equal(tool.wps.length, 2);
const s = emitted[emitted.length - 1];
assert.equal(s.points, 2);
assert.ok(s.km > 0.65 && s.km < 0.8, `km ${s.km}`); // two 330 m legs, from the coordinates
assert.equal(s.ascent, null);
assert.equal(s.seconds, 0);
assert.equal(tool._reqId, 1, "an in-flight reply must not replace the hand-off");

tool._reqId = 0;
tool.setWaypoints(pins);
assert.equal(recalcs, 1, "an ordinary edit still re-routes");
console.log("route-handoff.test.js ok");
