// RouteTool routes through the injected routeWaypoints and never reaches for the network; Leaflet stub.
//   node bench/route-local.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
require("../app/src/route.js");
const { RouteTool, L } = global;

global.fetch = () => { throw new Error("route.js must not fetch"); };

const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const A = L.latLng(51, 13.7), B = L.latLng(51, 13.71), C = L.latLng(51.001, 13.72);
const line = [[13.7, 51, 100], [13.705, 51.001, 110], [13.71, 51, 105]];
const stats = { km: 0.7, seconds: 540, ascent: 10, descent: 5 };

function tool(routeWaypoints, profile) {
  const emitted = [];
  const t = new RouteTool(global.fakeMap(), { onChange: (s) => emitted.push(s), routeWaypoints, profile });
  return { t, emitted, last: () => emitted[emitted.length - 1] };
}

(async () => {
  { // no page script names a routing host
    const dir = require("node:path").join(__dirname, "..", "app", "src");
    for (const f of require("node:fs").readdirSync(dir))
      assert.ok(!/brouter\.de/.test(require("node:fs").readFileSync(require("node:path").join(dir, f), "utf8")), `${f} names brouter.de`);
  }
  { // two pins: routed through routeWaypoints with the pins and the travel mode, stats emitted as given
    const calls = [];
    const { t, last } = tool(async (pts, mode) => { calls.push([pts, mode]); return { coords: line, stats }; }, "hiking-mountain");
    t.add(A);
    assert.equal(calls.length, 0, "one pin is not a route");
    t.add(B);
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0].map((p) => [p.lat, p.lng]), [[51, 13.7], [51, 13.71]]);
    assert.equal(calls[0][1], "hiking-mountain");
    assert.deepEqual(last(), { points: 2, ...stats });
    assert.deepEqual(t.routeCoords, line, "the routed line keeps its elevation");
  }
  { // an error result: straight line between the pins and { points, error: true } with the reason it came with
    const { t, last } = tool(async () => ({ error: true, why: { reason: "off-network" } }));
    t.add(A); t.add(B);
    await tick();
    assert.deepEqual(last(), { points: 2, error: true, why: { reason: "off-network" } });
    assert.deepEqual(t.routeCoords, [[13.7, 51], [13.71, 51]]);
  }
  { // a routeWaypoints that rejects, or none at all, is an internal error; only the class is logged
    const logged = [];
    const orig = console.error;
    console.error = (...a) => logged.push(a);
    const rejecting = tool(async () => { throw new TypeError("tile 12:34 missing"); });
    rejecting.t.add(A); rejecting.t.add(B);
    await tick();
    console.error = orig;
    assert.deepEqual(rejecting.last(), { points: 2, error: true, why: { reason: "internal" } });
    assert.deepEqual(logged, [["[route] routeWaypoints threw", "TypeError"]], "the message, which can name tiles, stays out of the log");
    const missing = tool(undefined);
    missing.t.add(A); missing.t.add(B);
    await tick();
    assert.deepEqual(missing.last(), { points: 2, error: true, why: { reason: "internal" } });
  }
  { // a reply still in flight is dropped when the route was cleared, shortened to one pin or edited; errors too
    const supersedes = [["clear", (t) => t.clear()], ["undo", (t) => t.undo()], ["edit", (t) => t.setProfile("fastbike")]];
    const replies = [{ coords: line, stats }, { error: true, why: { reason: "no-path" } }];
    for (const [name, supersede] of supersedes) for (const reply of replies) {
      const first = deferred();
      let calls = 0;
      const { t, emitted } = tool(() => (calls++ === 0 ? first.promise : new Promise(() => {})));
      t.add(A); t.add(B);
      supersede(t);
      const seen = emitted.length, coords = JSON.stringify(t.routeCoords);
      first.resolve(reply);
      await tick();
      assert.equal(emitted.length, seen, `${name}: a late ${reply.error ? "error" : "route"} emits nothing`);
      assert.equal(JSON.stringify(t.routeCoords), coords, `${name}: a late ${reply.error ? "error" : "route"} draws nothing`);
    }
  }
  { // an older answer arriving after a newer request is ignored
    const first = deferred(), second = deferred();
    const pending = [first, second];
    const { t, last } = tool(() => pending.shift().promise);
    t.add(A); t.add(B);             // request 1
    const r1 = [[13.7, 51], [13.71, 51]];
    t.setProfile("fastbike");       // request 2 supersedes it
    second.resolve({ coords: line, stats });
    await tick();
    first.resolve({ coords: r1, stats: { km: 9, seconds: 1, ascent: 0, descent: 0 } });
    await tick();
    assert.deepEqual(t.routeCoords, line);
    assert.equal(last().km, stats.km);
  }
  { // a hand-off carries its own stats and asks nobody
    let asked = 0;
    const { t, last } = tool(async () => { asked++; return { coords: line, stats }; });
    t.setFixedRoute([A, B], line, { km: 1.2, seconds: 700, ascent: 3, descent: 4 });
    await tick();
    assert.equal(asked, 0);
    assert.deepEqual(last(), { points: 2, km: 1.2, seconds: 700, ascent: 3, descent: 4 });
    assert.deepEqual(t.routeCoords, line);
  }
  { // heights that arrive late refine a hand-off, unless the route was edited or cleared meanwhile
    const { t, last } = tool(async () => ({ coords: line, stats }));
    const flat = [[13.7, 51], [13.705, 51.001], [13.71, 51]];
    const token = t.setFixedRoute([A, B], flat, { km: 1, seconds: 600, ascent: null, descent: null });
    assert.equal(t.refineFixedRoute(token, line, stats), true);
    assert.deepEqual(last(), { points: 2, ...stats });
    assert.deepEqual(t.routeCoords, line);
    const firstHandoff = t.setFixedRoute([A, B], flat, { km: 1, seconds: 600, ascent: null, descent: null });
    t.setFixedRoute([A, B], flat, { km: 1, seconds: 600, ascent: null, descent: null });
    assert.equal(t.refineFixedRoute(firstHandoff, line, stats), false, "a newer hand-off wins");
    const edited = t.setFixedRoute([A, B], flat, { km: 1, seconds: 600, ascent: null, descent: null });
    t.add(C);
    assert.equal(t.refineFixedRoute(edited, line, stats), false, "an edit since the hand-off wins");
    const again = t.setFixedRoute([A, B], flat, { km: 1, seconds: 600, ascent: null, descent: null });
    t.clear();
    assert.equal(t.refineFixedRoute(again, line, stats), false, "a cleared route stays cleared");
    assert.deepEqual(t.routeCoords, []);
    const third = t.setFixedRoute([A, B], flat, { km: 1, seconds: 600, ascent: null, descent: null });
    t.undo(); // down to one pin: no route left to refine
    assert.equal(t.refineFixedRoute(third, line, stats), false, "removing a pin supersedes the hand-off");
  }
  { // a pin added after routing re-asks with the new pins; reverse and mode changes too
    const calls = [];
    const { t } = tool(async (pts, mode) => { calls.push([pts.map((p) => p.lat + "," + p.lng).join("|"), mode]); return { coords: line, stats }; });
    t.add(A); t.add(B); t.add(C);
    await tick();
    t.reverse();
    t.setProfile("fastbike");
    await tick();
    assert.equal(calls.length, 4); // the second pin, the third, the reverse, the mode
    assert.equal(calls[2][0], "51.001,13.72|51,13.71|51,13.7");
    assert.equal(calls[3][1], "fastbike");
  }
  { // the Google Maps link maps car and shortest to driving, hiking to walking, and any other mode, such as one the page has no button for, to bicycling
    const { t } = tool(async () => ({ coords: line, stats }), "unlisted-mode");
    t.add(A); t.add(B);
    assert.match(t.googleMapsUrl(), /travelmode=bicycling/);
    t.setProfile("car-fast");
    assert.match(t.googleMapsUrl(), /travelmode=driving/);
    t.setProfile("hiking-mountain");
    assert.match(t.googleMapsUrl(), /travelmode=walking/);
  }
  { // the street download's progress reaches the loading state; a superseded request's progress does not
    const first = deferred(), progress = [];
    const { t, emitted } = tool(async (pts, mode, onProgress) => { progress.push(onProgress); await first.promise; return { coords: line, stats }; });
    t.add(A); t.add(B);
    await tick();
    progress[0]({ done: 1, total: 3 });
    assert.deepEqual(emitted[emitted.length - 1], { points: 2, loading: true, done: 1, total: 3 });
    t.add(C);
    await tick();
    const before = emitted.length;
    progress[0]({ done: 2, total: 3 });
    assert.equal(emitted.length, before, "the old request's progress is dropped");
    progress[1]({ done: 0, total: 2 });
    assert.deepEqual(emitted[emitted.length - 1], { points: 3, loading: true, done: 0, total: 2 });
    first.resolve();
  }
  console.log("route-local.test.js ok");
})();
