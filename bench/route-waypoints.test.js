// RouteLocal: pins -> street tiles -> LocalRouter -> elevation -> estimates; synthetic streets, no network.
//   node bench/route-waypoints.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
require("../app/src/routeLocal.js");
const { GraphPlanner, RouteLocal, Estimates, SuggestTool } = global;

const KX = 111320 * Math.cos(51 * Math.PI / 180), KY = 110540;
const ll = (x, y) => ({ lat: 51 + y / KY, lon: 13.7 + x / KX });
const pt = (x, y) => ({ lat: 51 + y / KY, lng: 13.7 + x / KX });
// one street along y=0 from x=0 to x=1000 in two ways, and a second street branching north at x=500
const ways = [[1, 2, [0, 0], [500, 0]], [2, 3, [500, 0], [1000, 0]], [2, 4, [500, 0], [500, 400]]];
const planner = new GraphPlanner({ ways: ways.map(([a, b, p, q], i) => ({ id: 100 + i, nodes: [a, b], geometry: [ll(...p), ll(...q)] })) }, () => 1);

function setup(over) {
  const calls = { ensure: [], planner: [], elevation: [] };
  const deps = Object.assign({
    streets: { ensureRects: async (rects, kind) => { calls.ensure.push({ rects, kind }); } },
    plannerFor: (mode) => { calls.planner.push(mode); return planner; },
    elevation: { elevationAt: async (pts) => { calls.elevation.push(pts); return pts.map((_, i) => 10 * (i + 1)); } },
    estimates: Estimates,
    streetKind: SuggestTool.streetKind,
  }, over);
  return { route: RouteLocal.create(deps), calls };
}

(async () => {
  { // two pins on the street: coords along it with z, stats from the estimates
    const { route, calls } = setup();
    const r = await route([pt(0, 0), pt(1000, 0)], "hiking-mountain");
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(r.coords.length >= 3 && r.coords.every((c) => c.length === 3));
    assert.ok(Math.abs(r.stats.km - 1) < 0.01, `km ${r.stats.km}`);
    assert.equal(r.stats.ascent, 10 * (r.coords.length - 1), "ascent is the fake elevation's rises");
    assert.equal(r.stats.descent, 0);
    assert.ok(r.stats.seconds > 600 && r.stats.seconds < 900, `a km on foot, ${r.stats.seconds} s`);
    assert.deepEqual(calls.elevation[0], r.coords.map((c) => [c[0], c[1]]), "elevation is asked for the routed line");
    assert.deepEqual(calls.planner, ["hiking-mountain"]);
  }
  { // one street request per route covers every leg, 1000 m beyond both pins, for the mode's street kind
    const { route, calls } = setup();
    const pins = [pt(0, 0), pt(500, 0), pt(500, 400)];
    await route(pins, "trekking");
    assert.equal(calls.ensure.length, 1, "one street request per route");
    const { rects, kind } = calls.ensure[0];
    assert.equal(kind, "bike");
    assert.equal(rects.length, 2, "one rect per leg");
    const padLat = 1000 / KY, padLng = 1000 / KX, eps = 1e-9;
    [[pins[0], pins[1]], [pins[1], pins[2]]].forEach(([a, b], i) => {
      const r = rects[i];
      assert.ok(r.s <= Math.min(a.lat, b.lat) - padLat + eps && r.n >= Math.max(a.lat, b.lat) + padLat - eps, `leg ${i} lat`);
      assert.ok(r.w <= Math.min(a.lng, b.lng) - padLng + eps && r.e >= Math.max(a.lng, b.lng) + padLng - eps, `leg ${i} lng`);
    });
    assert.ok(rects.every((r) => r.n - r.s < 2 * padLat + 500 / KY + 1e-9), "padding is 1000 m, not more");
    await route(pins, "hiking-mountain");
    assert.equal(calls.ensure[1].kind, "run");
    await route(pins, "car-fast");
    assert.equal(calls.ensure[2].kind, "car");
    await route(pins, "fastbike");
    assert.equal(calls.ensure[3].kind, "bike");
  }
  { // a pin far from every street: the router's reason comes back
    const { route } = setup();
    const r = await route([pt(0, 0), pt(0, 5000)], "trekking");
    assert.equal(r.error, true);
    assert.equal(r.why.reason, "off-network");
    assert.equal(r.why.point, 1, "the pin that is off the streets");
  }
  { // a rejected street fetch is streets-fetch with the download's facts and none of its text; no planner (no ways at all) is no-street-data
    const failing = setup({ streets: { ensureRects: async () => { throw Object.assign(new Error("overpass HTTP 502"), { reason: "busy", retryAt: 7 }); } } });
    const orig = console.warn;
    console.warn = () => {};
    const r = await failing.route([pt(0, 0), pt(1000, 0)], "trekking");
    console.warn = orig;
    assert.deepEqual(r, { error: true, why: { reason: "streets-fetch", download: { reason: "busy", done: undefined, total: undefined, retryAt: 7, cause: undefined } } });
    const empty = setup({ plannerFor: () => null });
    assert.deepEqual(await empty.route([pt(0, 0), pt(1000, 0)], "trekking"), { error: true, why: { reason: "no-street-data" } });
  }
  { // the download's progress is handed to the street fetch
    const seen = [];
    const { route } = setup({ streets: { ensureRects: async (rects, kind, opts) => { opts.onProgress({ done: 0, total: 2 }); } } });
    await route([pt(0, 0), pt(1000, 0)], "trekking", (p) => seen.push(p));
    assert.deepEqual(seen, [{ done: 0, total: 2 }]);
  }
  { // pins farther apart than a street download may cover: declined before any request
    const { route, calls } = setup();
    const r = await route([pt(0, 0), pt(40000, 0)], "trekking");
    assert.deepEqual(r, { error: true, why: { reason: "too-far" } });
    assert.equal(calls.ensure.length, 0);
  }
  { // some heights missing: carried forward, so the line keeps its z and the climb is a number
    const { route } = setup({ elevation: { elevationAt: async (pts) => pts.map((_, i) => (i % 2 ? null : 10 * i)) } });
    const r = await route([pt(0, 0), pt(1000, 0)], "trekking");
    assert.ok(r.coords.every((c) => c.length === 3));
    assert.equal(typeof r.stats.ascent, "number");
  }
  { // a multi-leg route is one line through every pin
    const { route } = setup();
    const r = await route([pt(0, 0), pt(500, 0), pt(500, 400)], "trekking");
    assert.ok(!r.error);
    assert.ok(Math.abs(r.stats.km - 0.9) < 0.02, `km ${r.stats.km}`);
  }
  { // a street source that fails is logged by its cause's class and the reason only
    const logged = [];
    const orig = console.warn;
    console.warn = (...a) => logged.push(a);
    const cause = Object.assign(new TypeError("no answer for tile 273:1020"), { reason: "offline" });
    const { route } = setup({ streets: { ensureRects: async () => { throw global.StreetIndex.downloadError(1, 2, cause); } } });
    const r = await route([pt(0, 0), pt(1000, 0)], "trekking");
    console.warn = orig;
    assert.deepEqual(logged, [["[route] streets unavailable", "TypeError", "streets-partial"]]);
    assert.deepEqual(r.why.download, { reason: "streets-partial", done: 1, total: 2, retryAt: undefined, cause: { reason: "offline" } });
  }
  { // no heights at all: a flat 2D line, and ascent and descent unknown rather than zero
    const { route } = setup({ elevation: { elevationAt: async (pts) => pts.map(() => null) } });
    const r = await route([pt(0, 0), pt(1000, 0)], "trekking");
    assert.ok(r.coords.every((c) => c.length === 2), "no z invented");
    assert.equal(r.stats.ascent, null);
    assert.equal(r.stats.descent, null);
    assert.ok(r.stats.km > 0.99 && r.stats.seconds > 0);
  }
  { // an elevation source that throws is the same as no heights
    const { route } = setup({ elevation: { elevationAt: async () => { throw new Error("tile"); } } });
    const r = await route([pt(0, 0), pt(1000, 0)], "trekking");
    assert.ok(!r.error);
    assert.ok(r.coords.every((c) => c.length === 2));
    assert.equal(r.stats.ascent, null);
    assert.equal(r.stats.descent, null);
    assert.ok(r.stats.km > 0.99 && r.stats.seconds > 0);
  }
  console.log("route-waypoints.test.js ok");
})();
