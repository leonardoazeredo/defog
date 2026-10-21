// Fog that moves while the page is open: street fractions, planner rewards and suggestion planners follow it.
//   node bench/fog-invalidate.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { makeGain } = require("./lib/gain.js");
const { FogParser, StreetIndex, GraphPlanner, SuggestTool, Reveal } = global;

const KX = 111320 * Math.cos(51 * Math.PI / 180), KY = 110540;
const ll = (x, y) => ({ lat: 51 + y / KY, lon: 13.7 + x / KX });
// a 500 m street due east, as one way with a node every 100 m
const way = {
  id: 7,
  nodes: [1, 2, 3, 4, 5, 6],
  geometry: [0, 100, 200, 300, 400, 500].map((x) => ll(x, 0)),
};
const centre = { lat: 51, lng: 13.7 + 250 / KX };

function world() {
  const fogMap = new FogParser.FogMap();
  const { corridorNewFrac } = makeGain(fogMap, FogParser);
  const streets = new StreetIndex({ newFrac: corridorNewFrac });
  streets._anchor(51);
  streets._addWay(way);
  streets.version++; // a fetch would have
  return { fogMap, streets };
}
// the cells a walk along the street reveals, as the page would add them
function walkAlongStreet() {
  const track = [];
  for (let x = 0; x <= 500; x += 10) track.push({ t: x * 1000, ...ll(x, 0), accuracy: 5 });
  return Reveal.reveal(track, Reveal.RULES);
}
const sum = (a) => a.reduce((s, v) => s + v, 0);

{ // newAreaM2 falls once the street's cells are revealed and the fractions are dropped
  const { fogMap, streets } = world();
  const before = streets.newAreaM2(centre, 400);
  assert.ok(before > 0, `before ${before}`);
  fogMap.addCells(walkAlongStreet());
  streets.invalidateFrac();
  const after = streets.newAreaM2(centre, 400);
  assert.ok(after < before * 0.5, `after ${after} vs before ${before}`);
}
{ // without invalidateFrac the cached fractions stay, which is the bug the call exists for
  const { fogMap, streets } = world();
  const before = streets.newAreaM2(centre, 400);
  fogMap.addCells(walkAlongStreet());
  assert.equal(streets.newAreaM2(centre, 400), before);
}
{ // invalidateFrac bumps the version the planner stamps its graph with
  const { streets } = world();
  const v = streets.version;
  streets.invalidateFrac();
  assert.ok(streets.version > v);
}
{ // a fog change makes the planner rebuild, and the rebuilt rewards use the new fog
  const { fogMap, streets } = world();
  const planner = new GraphPlanner(streets, streets.newFrac, undefined, undefined, () => fogMap.version);
  planner.build();
  const stamp = planner.builtStamp, reward = sum(planner.reward);
  assert.ok(reward > 0, `reward ${reward}`);
  planner.build();
  assert.equal(planner.builtStamp, stamp, "nothing changed: no rebuild");
  fogMap.addCells(walkAlongStreet());
  planner.build();
  assert.notEqual(planner.builtStamp, stamp);
  assert.ok(sum(planner.reward) < reward * 0.5, `reward ${sum(planner.reward)} vs ${reward}`);
}
{ // SuggestTool hands its planners the fog version: a reveal changes the rewards of the planner plannerFor hands out, without a new planner
  const { fogMap, streets } = world();
  const tool = new SuggestTool({}, { fogMap, streets, computeGain: () => null });
  const planner = tool.plannerFor("trekking");
  planner.build();
  const reward = sum(planner.reward);
  fogMap.addCells(walkAlongStreet());
  assert.equal(tool.plannerFor("trekking"), planner, "same planner, rebuilt in place");
  planner.build();
  assert.ok(sum(planner.reward) < reward * 0.5, `reward ${sum(planner.reward)} vs ${reward}`);
}
{ // clearing the overlay is a fog change as well: the reward comes back
  const { fogMap, streets } = world();
  const planner = new GraphPlanner(streets, streets.newFrac, undefined, undefined, () => fogMap.version);
  planner.build();
  const reward = sum(planner.reward);
  fogMap.addCells(walkAlongStreet());
  planner.build();
  fogMap.clearOverlay();
  planner.build();
  assert.ok(Math.abs(sum(planner.reward) - reward) < 1e-6, `reward ${sum(planner.reward)} vs ${reward}`);
}

console.log("fog-invalidate.test.js ok");
