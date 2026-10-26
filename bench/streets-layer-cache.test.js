// StreetsInFogLayer: a pan reads only the cache; the "Download this area" button is the one fetch.
//   node bench/streets-layer-cache.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
global.L.Control = global.L.Control || { extend: () => function () {} };
require("../app/src/streetMessages.js");
require("../app/src/streetsLayer.js");
const { StreetsInFogLayer, StreetIndex, StreetMessages } = global;

const tilesOf = (r) => StreetIndex.tilesCovering(r).map(StreetIndex.tileBounds);
const TWO = { s: 51.0, w: 13.7, n: 51.025, e: 13.75 }; // two tiles of the 0.025° grid

// A layer over a real StreetIndex; `say` records [text, action label or null].
function fakeLayer(fetchStreets, view = TWO) {
  const layer = Object.create(StreetsInFogLayer.prototype);
  const state = { said: [], drawn: 0 };
  const streets = new StreetIndex({ newFrac: () => 1, fetchStreets });
  Object.assign(layer, {
    enabled: true, _busy: false, _dirty: false, _fetching: false, _failure: null, _missingRects: [], _tooBig: false, _view: 0,
    _visibleTiles: () => tilesOf(view),
    _say: (text, action) => state.said.push([text, action ? action.label : null]),
    _classifyNew: async () => {}, _draw: () => { state.drawn++; },
    dim: { setLatLngs: () => {} }, halo: { setLatLngs: () => {} }, core: { setLatLngs: () => {} },
    streets
  });
  return { layer, state, streets };
}

// A street source holding the given tiles ("x:y"), and fetching anything over the "network" when not cache-only.
function source(held, net) {
  const calls = [];
  const fn = async (tiles, kind, onTile, opts) => {
    const cacheOnly = !!(opts && opts.cacheOnly);
    calls.push({ tiles: tiles.map((t) => t.x + ":" + t.y), cacheOnly });
    const out = new Map();
    for (const t of tiles) {
      const k = t.x + ":" + t.y;
      if (!held.has(k) && cacheOnly) continue;
      if (!held.has(k)) await net(t);
      const answer = { ways: [], groups: {} };
      out.set(k, answer);
      onTile(t, answer);
    }
    return out;
  };
  return { fn, calls };
}

(async () => {
  { // a view with uncached tiles: no request on the default source, the count and the button
    let posts = 0;
    const origFetch = global.fetch;
    global.fetch = async () => { posts++; throw new Error("no network on a pan"); };
    const { layer, state, streets } = fakeLayer(undefined);
    streets.fetchStreets = StreetIndex.overpassFetch;
    await layer._update();
    global.fetch = origFetch;
    assert.equal(posts, 0, "a pan never reaches Overpass.post");
    assert.deepEqual(state.said.pop(), ["Street map known for 0 of 2 pieces here.", "Download this area"]);
  }
  { // part of the view cached: drawn at once, the rest counted; the button makes one normal run with progress
    const keys = StreetIndex.tilesCovering(TWO).map((t) => t.x + ":" + t.y);
    const src = source(new Set([keys[0]]), async () => {});
    const { layer, state, streets } = fakeLayer(src.fn);
    const runs = [];
    const ensure = streets.ensureRects.bind(streets);
    streets.ensureRects = (rects, kind, opts) => { runs.push(!!(opts && opts.cacheOnly)); return ensure(rects, kind, opts); };
    await layer._update();
    assert.equal(state.drawn, 1, "the cached tile is painted without a download");
    assert.deepEqual(state.said.pop(), ["Street map known for 1 of 2 pieces here.", "Download this area"]);
    state.said.length = 0;
    await layer._download();
    assert.deepEqual(runs, [true, false, true], "one cache-only read, the button's one run, then a recount");
    assert.deepEqual(src.calls[1], { tiles: [keys[1]], cacheOnly: false }, "the button asks only for the missing piece");
    assert.deepEqual(state.said, [["Getting the street map, 0 of 1…", null], ["Getting the street map, 1 of 1…", null], ["", null]],
      "the badge counts the download, then clears");
    assert.equal(state.drawn, 2);
  }
  { // a second tap while the download runs does nothing
    let release;
    const gate = new Promise((r) => { release = r; });
    const src = source(new Set(), () => gate);
    const { layer, streets } = fakeLayer(src.fn);
    let runs = 0;
    const ensure = streets.ensureRects.bind(streets);
    streets.ensureRects = (rects, kind, opts) => { if (!(opts && opts.cacheOnly)) runs++; return ensure(rects, kind, opts); };
    await layer._update();
    const first = layer._download();
    const second = layer._download();
    release();
    await Promise.all([first, second]);
    assert.equal(runs, 1, "two taps, one download");
  }
  { // more missing pieces than one tap may fetch: zoom in, no button
    const { layer, state } = fakeLayer(source(new Set(), async () => {}).fn, { s: 51.0, w: 13.7, n: 51.1, e: 13.825 });
    await layer._update();
    const [text, action] = state.said.pop();
    assert.equal(text, "Street map known for 0 of 20 pieces here. Zoom in to download the rest.");
    assert.equal(action, null);
    await layer._download();
    assert.equal(layer._fetching, false, "nothing offered, nothing fetched");
  }
  { // a failed download: the page's wording without a countdown that would freeze, a Try again button,
    // never a quiet retry; a pan clears it
    const retryAt = 60_000;
    const src = source(new Set(), async () => { throw Object.assign(new Error("overpass HTTP 429"), { reason: "busy", retryAt }); });
    const { layer, state } = fakeLayer(src.fn);
    await layer._update();
    await layer._download();
    assert.deepEqual(state.said.pop(), ["The street servers are busy. Try again in a minute.", "Try again"],
      "no seconds left to count down: nothing redraws the badge once retryAt passes");
    assert.equal(src.calls.filter((c) => !c.cacheOnly).length, 1, "no quiet retry");
    await layer._update();
    assert.equal(src.calls.filter((c) => !c.cacheOnly).length, 1, "a pan does not retry either");
    assert.equal(state.said.pop()[1], "Try again", "the failure stays until the user moves the map");
    layer._moved();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(state.said.pop(), ["Street map known for 0 of 2 pieces here.", "Download this area"]);
  }
  { // a download that fails after the map moved does not word the new view, nor offer its Try again there
    let fail;
    const gate = new Promise((r, j) => { fail = j; });
    gate.catch(() => {});
    const src = source(new Set(), () => gate);
    const { layer, state } = fakeLayer(src.fn);
    await layer._update();
    const run = layer._download();
    layer._moved();
    await new Promise((r) => setImmediate(r));
    fail(Object.assign(new Error("overpass HTTP 429"), { reason: "busy" }));
    await run;
    assert.equal(layer._failure, null);
    assert.deepEqual(state.said.pop(), ["Street map known for 0 of 2 pieces here.", "Download this area"]);
  }
  { // a bug while reading the cache is not a download: the generic text, its class logged
    const logged = [], orig = console.error;
    console.error = (...a) => logged.push(a);
    const { layer, state, streets } = fakeLayer(source(new Set(), async () => {}).fn);
    streets.ensureRects = async () => { throw new TypeError("cannot read tile 273:1020"); };
    await layer._update();
    console.error = orig;
    assert.deepEqual(state.said.pop(), [StreetMessages.describe({}), null]);
    assert.deepEqual(logged, [["[streets layer] reading streets threw", "TypeError"]]);
  }
  { // a bug during the download: its class logged, the generic text
    const logged = [], orig = console.error;
    const { layer, state, streets } = fakeLayer(source(new Set(), async () => {}).fn);
    await layer._update();
    const ensure = streets.ensureRects.bind(streets);
    streets.ensureRects = async (r, k, opts) => { if (!(opts && opts.cacheOnly)) throw new TypeError("tile 273:1020"); return ensure(r, k, opts); };
    console.error = (...a) => logged.push(a);
    await layer._download();
    console.error = orig;
    assert.deepEqual(logged, [["[streets layer] downloading streets threw", "TypeError"]]);
    assert.deepEqual(state.said.pop(), [StreetMessages.describe({}), "Try again"]);
  }
  { // zoomed out while the download runs: progress does not overwrite the zoom-in text
    let release;
    const gate = new Promise((r) => { release = r; });
    const view = { b: TWO };
    const { layer, state } = fakeLayer(source(new Set(), () => gate).fn);
    layer._visibleTiles = () => tilesOf(view.b);
    await layer._update();
    const run = layer._download();
    view.b = { s: 50.0, w: 13.0, n: 51.0, e: 14.0 };
    await layer._update();
    assert.match(state.said[state.said.length - 1][0], /Zoom in/);
    const at = state.said.length;
    release();
    await run;
    assert.ok(state.said.slice(at).every(([t]) => /Zoom in/.test(t)), "no progress over the zoom-in text");
  }
  { // painting is capped by the index's memory: a 48-tile view paints from the cache, a larger one asks to zoom in
    assert.equal(StreetsInFogLayer.MAX_TILES, 48);
    const view = (b) => ({ getBounds: () => ({ getSouth: () => b.s, getWest: () => b.w, getNorth: () => b.n, getEast: () => b.e }) });
    const ok = fakeLayer(source(new Set(), async () => {}).fn);
    delete ok.layer._visibleTiles;
    ok.layer.map = view({ s: 51.0, w: 13.7, n: 51.15, e: 13.9 });
    let asked = 0;
    const ensure = ok.streets.ensureRects.bind(ok.streets);
    ok.streets.ensureRects = (t, k, o) => { asked = t.length; return ensure(t, k, o); };
    await ok.layer._update();
    assert.equal(asked, 48);
    const big = fakeLayer(source(new Set(), async () => {}).fn);
    delete big.layer._visibleTiles;
    big.layer.map = view({ s: 51.0, w: 13.7, n: 51.16, e: 13.9 });
    await big.layer._update();
    assert.match(big.state.said.pop()[0], /Zoom in/);
  }
  console.log("streets-layer-cache.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
