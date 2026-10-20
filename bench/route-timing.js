// How fast routeWaypoints answers a pin drag once the streets are loaded.
//   node bench/route-timing.js [scenario]      default scenario: berlin-run-10k
// The streets come from bench/cache/ through the bench tile fetch (the scenario's own run warms them),
// then every fetch is cut off: a drag whose padded rects reach a tile the warm-up did not cover counts
// as a live request and fails the script. Heights are a synthetic profile, since the real source
// fetches from the network; the page logs the real timing on a device.
"use strict";
const { SuggestTool, StreetIndex, FogParser } = require("./lib/load.js");
require("../app/src/routeLocal.js");
const cache = require("./lib/fetch-cache.js");
const { installTileFetch } = require("./lib/tileFetch.js");
const scenarios = require("./scenarios.js");

const DRAGS = 30, DRAG_M = 200, BUDGET_P95_MS = 300;
const name = process.argv[2] || "berlin-run-10k";
const sc = scenarios.find((s) => s.name === name);
if (!sc) { console.error(`no scenario ${name}`); process.exit(2); }

const KY = 110540;
const offset = (p, east, north) => ({ lat: p.lat + north / KY, lng: p.lng + east / (111320 * Math.cos(p.lat * Math.PI / 180)) });
const pct = (xs, q) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)];

(async () => {
  cache.install();
  cache.resetCounters();
  const streets = new StreetIndex({ newFrac: () => 1 });
  installTileFetch(streets);
  const tool = new SuggestTool(global.fakeMap(), { fogMap: new FogParser.FogMap(), computeGain: () => null, streets });
  await new Promise((resolve, reject) => {
    tool.onResults = (s) => { if (s && !s.loading) resolve(); };
    tool.mode = sc.mode;
    tool.a = { getLatLng: () => global.L.latLng(sc.a[0], sc.a[1]) };
    tool.suggest(sc.profile, { distM: sc.distM, buffer: sc.buffer || 0.15 }).catch(reject);
  });
  const warm = cache.counters();
  if (warm.misses) { console.error(`warm-up made ${warm.misses} live requests: the scenario is not in bench/cache/`); process.exit(1); }

  let live = 0;
  streets.fetchStreets = async () => { live++; throw new Error("live street fetch"); };
  const elevation = { elevationAt: async (pts) => pts.map((_, i) => 100 + 15 * Math.sin(i / 15)) };
  const routeWaypoints = global.RouteLocal.create({
    streets, plannerFor: (p) => tool.plannerFor(p), elevation, estimates: global.Estimates, streetKind: SuggestTool.streetKind,
  });

  // a 5 km route: end pin along a bearing until the routed length lands in 4.5-5.5 km, via pin on the street halfway
  const A = { lat: sc.a[0], lng: sc.a[1] };
  const router = new global.LocalRouter(tool.plannerFor(sc.profile));
  let base = null;
  for (let d = 3000; d <= 5000 && !base; d += 250) {
    const B = offset(A, d * Math.cos(Math.PI / 6), d * Math.sin(Math.PI / 6));
    const r = router.route([A, B]);
    if (r && r.lenM > 4500 && r.lenM < 5500) base = { B, route: r };
  }
  if (!base) { console.error("no 5 km route found from the scenario start"); process.exit(1); }
  const mid = base.route.coords[Math.floor(base.route.coords.length / 2)];
  const M = { lat: mid[1], lng: mid[0] };

  const first = performance.now();
  const r0 = await routeWaypoints([A, M, base.B], sc.profile);
  const firstMs = performance.now() - first;
  if (r0.error) { console.error(`first route failed: ${r0.why && r0.why.reason}`); process.exit(1); }

  const ms = [];
  let failed = 0;
  for (let i = 0; i < DRAGS; i++) {
    const a = (i / DRAGS) * 2 * Math.PI;
    const t = performance.now();
    const r = await routeWaypoints([A, offset(M, DRAG_M * Math.cos(a), DRAG_M * Math.sin(a)), base.B], sc.profile);
    ms.push(performance.now() - t);
    if (r.error) failed++;
  }
  const med = pct(ms, 0.5), p95 = pct(ms, 0.95);
  console.log(`${sc.name}: ${(base.route.lenM / 1000).toFixed(1)} km route, first ${firstMs.toFixed(0)} ms (the graph was built by the search for the 5 km route), ${DRAGS} drags of ${DRAG_M} m: median ${med.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms (budget ${BUDGET_P95_MS})`);
  console.log(`live street requests ${live}, failed routes ${failed}`);
  if (live || failed || p95 > BUDGET_P95_MS) process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });
