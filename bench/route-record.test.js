// RouteTool.routeRecord: the route as the phone app's `sendRoute` message carries it; Leaflet stub, no network.
//   node bench/route-record.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
require("../app/src/route.js");
const { RouteTool, L } = global;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const pins = [L.latLng(51, 13.7), L.latLng(51, 13.71)];
const C = [[13.7, 51, 120.5], [13.705, 51.001, 121], [13.71, 51, 119]];
const stats = { km: 0.7, seconds: 520, ascent: 3.5, descent: 5 };

function fresh(opts) { return new RouteTool(global.fakeMap(), opts || {}); }

// no route yet
{
  const tool = fresh();
  assert.equal(tool.routeRecord(), null, "nothing to send before a route exists");
}

// a handed-over route
{
  const tool = fresh({ profile: "hiking-mountain" });
  tool.setFixedRoute(pins, C, stats);
  const rec = tool.routeRecord();
  assert.match(rec.id, UUID);
  assert.match(rec.createdAt, ISO);
  assert.equal(rec.mode, "p2p", "start and end are apart");
  assert.equal(rec.travelMode, "hiking-mountain");
  assert.deepEqual(rec.waypoints, [{ lat: 51, lng: 13.7 }, { lat: 51, lng: 13.71 }]);
  assert.deepEqual(rec.coords, C);
  assert.deepEqual(rec.stats, { distanceM: 700, seconds: 520, ascentM: 3.5, descentM: 5 });
  assert.match(rec.gpx, new RegExp(`<keywords>crossfog-route:${rec.id}</keywords>`), "the GPX names the record's own id");
  assert.equal((rec.gpx.match(/<trkpt /g) || []).length, 3);
  assert.equal(rec.targetDistanceM, undefined, "a drawn or handed-over route has no target");
}

// the id follows the route: stable through edits, new after a clear or another route
{
  const tool = fresh();
  tool.setFixedRoute(pins, C, stats);
  const first = tool.routeRecord();
  assert.equal(tool.routeRecord().id, first.id, "asking twice gives one id");
  assert.equal(tool.routeRecord().createdAt, first.createdAt);

  tool._applyRoute([...C, [13.72, 51.001, 118]], { ...stats, km: 0.9 });
  const edited = tool.routeRecord();
  assert.equal(edited.id, first.id, "an edit keeps the id, so a re-send replaces the route the watch has");
  assert.equal(edited.stats.distanceM, 900);
  assert.notEqual(edited.gpx, first.gpx);

  const token = tool._reqId;
  tool.refineFixedRoute(token, C, stats);
  assert.equal(tool.routeRecord().id, first.id, "heights arriving late keep the id");

  tool.clear();
  assert.equal(tool.routeRecord(), null, "a cleared route has no record");
  tool.setFixedRoute(pins, C, stats);
  assert.notEqual(tool.routeRecord().id, first.id, "a new route after a clear is a new id");

  const second = tool.routeRecord().id;
  tool.setFixedRoute(pins, C, stats);
  assert.notEqual(tool.routeRecord().id, second, "adopting another route replaces the route, id included");
  const third = tool.routeRecord().id;
  tool.setWaypoints(pins);
  tool._applyRoute(C, stats);
  assert.notEqual(tool.routeRecord().id, third, "replacing every waypoint is a new route");
}

// a loop
{
  const tool = fresh();
  tool.setFixedRoute([pins[0], L.latLng(51.002, 13.7), L.latLng(51.00002, 13.70001)], C, stats);
  assert.equal(tool.routeRecord().mode, "loop", "it ends where it began");
}

// stats the page does not know are null, never undefined or absent
{
  const tool = fresh();
  tool.setFixedRoute(pins, C.map((c) => [c[0], c[1]]), { km: 0.7, seconds: null, ascent: null, descent: null });
  const rec = tool.routeRecord();
  assert.deepEqual(rec.stats, { distanceM: 700, seconds: null, ascentM: null, descentM: null });
  assert.deepEqual(rec.coords[0], [13.7, 51], "a 2D point stays 2D");

  const odd = fresh();
  odd.setFixedRoute(pins, [[13.7, 51, null], [13.71, 51, 100]], { km: 0.7 });
  const r2 = odd.routeRecord();
  assert.deepEqual(r2.coords, [[13.7, 51], [13.71, 51, 100]], "a missing height never travels as null");
  assert.deepEqual(r2.stats, { distanceM: 700, seconds: null, ascentM: null, descentM: null });
}

// longitudes past the antimeridian wrap into [-180, 180]
{
  const tool = fresh();
  tool.setFixedRoute([L.latLng(10, 190), L.latLng(10, 191)], [[190, 10], [191, 10]], { km: 100, seconds: 1, ascent: 0, descent: 0 });
  const rec = tool.routeRecord();
  assert.deepEqual(rec.waypoints.map((w) => w.lng), [-170, -169]);
  assert.deepEqual(rec.coords.map((c) => c[0]), [-170, -169]);
}

// heights still on the way: no record to send until they land, are given up on, or the route is cleared
(async () => {
  const flat = { km: 0.7, seconds: 520, ascent: null, descent: null };
  let changes = 0;
  const tool = fresh({ onChange: () => { changes++; } });
  const token = tool.setFixedRoute(pins, C, flat, { refining: true });
  assert.equal(tool.routeRecord(), null, "the flat route is not sent while its heights are pending");
  assert.equal(tool.refineFixedRoute(token, C, stats), true);
  assert.ok(tool.routeRecord(), "refined route can be sent");
  assert.equal(tool.routeRecord().stats.ascentM, 3.5);

  const t2 = fresh({ onChange: () => { changes++; } });
  const tok2 = t2.setFixedRoute(pins, C, flat, { refining: true });
  const before = changes;
  assert.equal(t2.settleFixedRoute(tok2), true, "heights never came: settle with the flat route");
  assert.ok(t2.routeRecord(), "settled route can be sent");
  assert.ok(changes > before, "settling tells the send control");
  assert.equal(t2.settleFixedRoute(tok2 + 1), false, "a stale token settles nothing");

  const t3 = fresh();
  const tok3 = t3.setFixedRoute(pins, C, flat, { refining: true });
  t3.clear();
  assert.equal(t3.settleFixedRoute(tok3), false);
  assert.equal(t3.routeRecord(), null, "cleared");
  const t5 = fresh({ onChange: () => { throw new Error("boom"); } });
  assert.throws(() => t5.setFixedRoute(pins, C, flat, { refining: true }));
  assert.ok(t5.routeRecord(), "a failed hand-over leaves no pending block behind");
  const t4 = fresh();
  t4.setFixedRoute(pins, C, flat); // no heights expected: sendable at once
  assert.ok(t4.routeRecord());
})().then(async () => {
  // no record while the line is only a guess: routing in flight, or failed
  const tool = fresh();
  let release;
  tool.routeWaypoints = () => new Promise((r) => { release = r; });
  tool.add(pins[0]);
  tool.add(pins[1]);
  assert.equal(tool.routeRecord(), null, "while routing, the old geometry is not the route");
  release({ coords: C, stats });
  await new Promise((r) => setImmediate(r));
  assert.ok(tool.routeRecord(), "once routed there is a record");

  tool.routeWaypoints = async () => ({ error: true, why: { reason: "no-path" } });
  tool.add(L.latLng(51.01, 13.72));
  await new Promise((r) => setImmediate(r));
  assert.equal(tool.routeRecord(), null, "a straight-line fallback is not a route to send");

  console.log("route-record.test.js ok");
});
