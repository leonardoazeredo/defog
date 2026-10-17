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

const kml = RouteTool.prototype.toKML.call(tool);
assert.match(kml, /<description>Map data © OpenStreetMap contributors, ODbL \(https:\/\/opendatacommons\.org\/licenses\/odbl\/\)<\/description>/);
assert.match(kml, /<coordinates>13\.700000,51\.000000,120\.5 13\.710000,51\.001000,121\.0<\/coordinates>/, "coordinates unchanged");

console.log("route-export.test.js ok");
