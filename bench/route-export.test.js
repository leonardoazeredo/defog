// RouteTool.toGPX / toKML: output credits OpenStreetMap (ODbL), track data unchanged; no network.
//   node bench/route-export.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
require("../app/src/route.js");
const { RouteTool } = global;

const tool = { profile: "trekking", routeCoords: [[13.7, 51, 120.5], [13.71, 51.001, 121]] };

const gpx = RouteTool.prototype.toGPX.call(tool);
assert.match(gpx, /<metadata>[\s\S]*<copyright author="OpenStreetMap contributors">[\s\S]*<license>https:\/\/opendatacommons\.org\/licenses\/odbl\/<\/license>[\s\S]*<\/metadata>/);
assert.match(gpx, /<link href="https:\/\/www\.openstreetmap\.org\/copyright">/);
assert.ok(gpx.indexOf("<metadata>") < gpx.indexOf("<trk>"), "GPX 1.1 puts metadata before trk");
assert.ok(gpx.indexOf("<copyright") < gpx.indexOf("<link"), "GPX 1.1 metadataType puts copyright before link");
assert.match(gpx, /<trkpt lat="51\.000000" lon="13\.700000"><ele>120\.5<\/ele><\/trkpt>/, "track points unchanged");

// toGPX writes the route id as a metadata keyword when the caller sets routeId; the watch reads it back to match an activity to its route.
const ID = "22222222-2222-4222-8222-222222222222";
const withId = { profile: "trekking", routeId: ID, routeCoords: [[13.7, 51, 120.5], [13.71, 51.001, 121], [13.72, 51.002, 119.25]] };
const idGpx = RouteTool.prototype.toGPX.call(withId);
assert.match(idGpx, new RegExp(`<keywords>crossfog-route:${ID}</keywords>`), "route id in the keywords");
assert.ok(idGpx.indexOf("<link") < idGpx.indexOf("<keywords>"), "GPX 1.1 metadataType puts keywords after link");
assert.ok(idGpx.indexOf("<keywords>") < idGpx.indexOf("</metadata>"), "keywords sit inside the metadata");
assert.equal((idGpx.match(/<ele>/g) || []).length, 3, "an <ele> on every point");
assert.match(idGpx, /<trkpt lat="51\.002000" lon="13\.720000"><ele>119\.3<\/ele><\/trkpt>/, "elevation of the last point");
assert.doesNotMatch(gpx, /<keywords>/, "a route without an id writes no keywords");
for (const bad of ["", "</keywords><x/>", "a&b"]) {
  assert.doesNotMatch(RouteTool.prototype.toGPX.call({ ...withId, routeId: bad }), /<keywords>/, "an id that is not a UUID is never written into the XML");
}

const kml = RouteTool.prototype.toKML.call(tool);
assert.match(kml, /<description>Map data © OpenStreetMap contributors, ODbL \(https:\/\/opendatacommons\.org\/licenses\/odbl\/\)<\/description>/);
assert.match(kml, /<coordinates>13\.700000,51\.000000,120\.5 13\.710000,51\.001000,121\.0<\/coordinates>/, "coordinates unchanged");

console.log("route-export.test.js ok");
