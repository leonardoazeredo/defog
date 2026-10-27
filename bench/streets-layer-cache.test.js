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
const BIG = { s: 50.0, w: 13.0, n: 51.0, e: 14.0 };      // past MAX_TILES
const INTERNAL = "Something went wrong while showing the street map. Reload the page and try again.";
const tick = () => new Promise((r) => setImmediate(r));

// A layer over a real StreetIndex; `say` records [text, action label or null], and the last action.
function fakeLayer(fetchStreets, view = TWO) {
  const layer = Object.create(StreetsInFogLayer.prototype);
  const state = { said: [], drawn: 0, action: null };
  const streets = new StreetIndex({ newFrac: () => 1, fetchStreets });
  const line = () => ({ setLatLngs: () => {}, addTo: () => {}, setStyle: () => {} });
  Object.assign(layer, {
    enabled: true, look: "light", color: "#4fd6e6", opacity: 1, _busy: false, _dirty: false, _fetching: false, _failure: null, _missingRects: [], _known: 0, _tooBig: false, _view: 0, _pass: 0,
    _visibleTiles: () => tilesOf(view),
    _say: (text, action) => { state.said.push([text, action ? action.label : null]); state.action = action || null; },
    _classifyNew: async () => {}, _draw: () => { state.drawn++; },
    dim: line(), halo: line(), core: line(), badge: { addTo: () => {} },
    map: { on: () => {}, off: () => {}, removeLayer: () => {}, removeControl: () => {}, getZoom: () => 14 },
    streets
  });
  layer._followIndex();
  return { layer, state, streets };
}
// Counts the normal (not cache-only) ensureRects runs, the downloads.
function countRuns(streets) {
  const runs = { n: 0 };
  const ensure = streets.ensureRects.bind(streets);
  streets.ensureRects = (rects, kind, opts) => { if (!(opts && opts.cacheOnly)) runs.n++; return ensure(rects, kind, opts); };
  return runs;
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
    let state;
    try {
      const made = fakeLayer(undefined);
      state = made.state;
      made.streets.fetchStreets = StreetIndex.overpassFetch;
      await made.layer._update();
    } finally { global.fetch = origFetch; }
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
    assert.deepEqual(state.said, [["Getting the street map, 1 of 2…", null], ["Getting the street map, 2 of 2…", null], ["", null]],
      "the badge counts the download over the whole view, the cached piece done, then clears");
    assert.equal(state.drawn, 2);
  }
  { // a failed download and its retry both count over the whole view, so the total stays the same
    let calls = 0;
    const src = source(new Set(), async () => { if (++calls === 2) throw Object.assign(new Error("slow"), { reason: "stalled" }); });
    const { layer, state } = fakeLayer(src.fn, { s: 51.0, w: 13.7, n: 51.025, e: 13.775 });
    await layer._update();
    state.said.length = 0;
    await layer._download();
    assert.deepEqual(state.said.map(([text]) => text).slice(0, 2), ["Getting the street map, 0 of 3…", "Getting the street map, 1 of 3…"]);
    assert.match(state.said.pop()[0], /^Got 1 of 3 pieces of the street map before the server got too slow\./);
    state.said.length = 0;
    await layer._download();
    assert.deepEqual(state.said.map(([text]) => text), ["Getting the street map, 1 of 3…", "Getting the street map, 2 of 3…", "Getting the street map, 3 of 3…", ""]);
  }
  { // the pieces already on the device are in the failure text's count too
    const view = { s: 51.0, w: 13.7, n: 51.025, e: 13.775 };
    let calls = 0;
    const src = source(new Set([StreetIndex.tilesCovering(view)[0].x + ":" + StreetIndex.tilesCovering(view)[0].y]),
      async () => { if (++calls === 2) throw Object.assign(new Error("slow"), { reason: "stalled" }); });
    const { layer, state } = fakeLayer(src.fn, view);
    await layer._update();
    state.said.length = 0;
    await layer._download();
    assert.deepEqual(state.said.map(([text]) => text).slice(0, 2), ["Getting the street map, 1 of 3…", "Getting the street map, 2 of 3…"]);
    assert.match(state.said.pop()[0], /^Got 2 of 3 pieces of the street map before the server got too slow\./);
  }
  { // a wait for a busy server shows in the badge, then the count again
    const src = async (tiles, kind, onTile, opts) => {
      const out = new Map();
      if (opts && opts.cacheOnly) return out;
      assert.equal(await opts.wait(Date.now() + 15000), true);
      for (const t of tiles) { out.set(t.x + ":" + t.y, { ways: [], groups: {} }); onTile(t, out.get(t.x + ":" + t.y)); }
      return out;
    };
    const { layer, state, streets } = fakeLayer(src);
    streets.sleep = async () => {};
    await layer._update();
    state.said.length = 0;
    await layer._download();
    assert.deepEqual(state.said.slice(0, 3).map(([text]) => text), ["Getting the street map, 0 of 2…",
      "The street servers are busy. Trying again in about 20 s… (0 of 2)", "Getting the street map, 0 of 2…"]);
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
  { // a bug while reading the cache is not a download: the internal text, its class logged
    const logged = [], orig = console.error;
    console.error = (...a) => logged.push(a);
    const { layer, state, streets } = fakeLayer(source(new Set(), async () => {}).fn);
    streets.ensureRects = async () => { throw new TypeError("cannot read tile 273:1020"); };
    await layer._update();
    console.error = orig;
    assert.deepEqual(state.said.pop(), [INTERNAL, null]);
    assert.deepEqual(logged, [["[streets layer] showing streets threw", "TypeError"]]);
  }
  { // a bug during the download: its class logged, the internal text
    const logged = [], orig = console.error;
    const { layer, state, streets } = fakeLayer(source(new Set(), async () => {}).fn);
    await layer._update();
    const ensure = streets.ensureRects.bind(streets);
    streets.ensureRects = async (r, k, opts) => { if (!(opts && opts.cacheOnly)) throw new TypeError("tile 273:1020"); return ensure(r, k, opts); };
    console.error = (...a) => logged.push(a);
    await layer._download();
    console.error = orig;
    assert.deepEqual(logged, [["[streets layer] downloading streets threw", "TypeError"]]);
    assert.deepEqual(state.said.pop(), [INTERNAL, "Try again"]);
  }
  { // a failed download logs its reason alone; one that ends after a move is dropped unlogged
    const warned = [], orig = console.warn;
    console.warn = (...a) => warned.push(a);
    try {
      const busy = () => Object.assign(new Error("overpass HTTP 429 at tile 273:1020"), { reason: "busy" });
      const a = fakeLayer(source(new Set(), async () => { throw busy(); }).fn);
      await a.layer._update();
      await a.layer._download();
      let fail;
      const gate = new Promise((r, j) => { fail = j; });
      gate.catch(() => {});
      const b = fakeLayer(source(new Set(), () => gate).fn);
      await b.layer._update();
      const run = b.layer._download();
      b.layer._moved();
      await tick();
      fail(busy());
      await run;
    } finally { console.warn = orig; }
    assert.deepEqual(warned, [["[streets layer] streets unavailable", "busy"]]);
  }
  { // a failure, the look switched off, the map moved unseen, the look on again: the failure is gone
    const src = source(new Set(), async () => { throw Object.assign(new Error("overpass HTTP 429"), { reason: "busy" }); });
    const { layer, state } = fakeLayer(src.fn);
    await layer._update();
    await layer._download();
    assert.equal(state.said[state.said.length - 1][1], "Try again");
    layer.setEnabled(false);
    layer.setEnabled(true);
    await tick();
    assert.deepEqual(state.said.pop(), ["Street map known for 0 of 2 pieces here.", "Download this area"]);
  }
  { // a download tapped, the look switched off and the map moved, then the download fails: the failure
    // belongs to a view no longer shown
    let fail;
    const gate = new Promise((r, j) => { fail = j; });
    gate.catch(() => {});
    const { layer, state } = fakeLayer(source(new Set(), () => gate).fn);
    await layer._update();
    const run = layer._download();
    await tick();
    layer.setEnabled(false);
    fail(Object.assign(new Error("overpass HTTP 429"), { reason: "busy" }));
    await run;
    assert.equal(layer._failure, null);
    layer.setEnabled(true);
    await tick();
    assert.deepEqual(state.said.pop(), ["Street map known for 0 of 2 pieces here.", "Download this area"]);
  }
  { // a pan's pass still reading when the map zooms out: it neither paints nor words the zoomed-out view,
    // and the button does nothing there
    const view = { b: TWO };
    const { layer, state, streets } = fakeLayer(source(new Set(), async () => {}).fn);
    layer._visibleTiles = () => tilesOf(view.b);
    await layer._update();
    const drawn = state.drawn;
    let release;
    const gate = new Promise((r) => { release = r; });
    const ensure = streets.ensureRects.bind(streets);
    streets.ensureRects = async (r, k, o) => { await gate; return ensure(r, k, o); };
    const pass = layer._update();
    view.b = BIG;
    layer._moved();
    assert.match(state.said[state.said.length - 1][0], /Zoom in/);
    release();
    await pass;
    assert.match(state.said[state.said.length - 1][0], /Zoom in/, "the late pass does not replace the zoom-in text");
    assert.equal(state.drawn, drawn, "nor paints over the cleared lines");
    const runs = countRuns(streets);
    await layer._download();
    assert.equal(runs.n, 0, "no download for a view past MAX_TILES");
  }
  { // a bug classifying a later slice (run from the message channel): the internal text, and the next
    // move works again
    const logged = [], orig = console.error;
    const { layer, state, streets } = fakeLayer(source(new Set(), async () => {}).fn);
    delete layer._classifyNew;
    layer.runs = []; layer.doneRuns = []; layer._cursor = 0;
    streets.ways = [{ id: 1 }, { id: 2 }];
    layer._classifyWay = (w) => {
      if (w.id === 2) throw new TypeError("bad way");
      const t0 = performance.now();
      while (performance.now() - t0 < 20); // past one slice, so way 2 runs in the next
    };
    console.error = (...a) => logged.push(a);
    await layer._update();
    console.error = orig;
    assert.deepEqual(state.said.pop(), [INTERNAL, null]);
    assert.deepEqual(logged, [["[streets layer] showing streets threw", "TypeError"]]);
    assert.equal(layer._busy, false);
    layer._moved();
    await tick(); await tick();
    assert.deepEqual(state.said.pop(), ["Street map known for 0 of 2 pieces here.", "Download this area"]);
  }
  { // a bug in the recount after a download: logged by class, worded as internal, never an unhandled rejection
    const logged = [], orig = console.error;
    const { layer, state } = fakeLayer(source(new Set(), async () => {}).fn);
    await layer._update();
    layer._visibleTiles = () => { throw new TypeError("bounds"); };
    console.error = (...a) => logged.push(a);
    await layer._download();
    console.error = orig;
    assert.deepEqual(logged, [["[streets layer] showing streets threw", "TypeError"]]);
    assert.deepEqual(state.said.pop(), [INTERNAL, null]);
  }
  { // the badge's buttons: "Download this area" and "Try again" each start one download
    const src = source(new Set(), async () => { throw Object.assign(new Error("overpass HTTP 429"), { reason: "busy" }); });
    const { layer, state, streets } = fakeLayer(src.fn);
    const runs = countRuns(streets);
    await layer._update();
    assert.equal(state.action.label, "Download this area");
    await state.action.run();
    assert.equal(runs.n, 1);
    assert.equal(state.action.label, "Try again");
    await state.action.run();
    assert.equal(runs.n, 2);
  }
  { // the real badge: its text and one button that downloads
    const { DomUtil, DomEvent } = global.L;
    const el = { kids: [], style: {}, _text: "" };
    Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v; this.kids = []; } });
    global.L.DomUtil = { create: (tag, cls, parent) => { const b = { tag, cls }; parent.kids.push(b); return b; } };
    global.L.DomEvent = { on: (b, ev, fn) => { b.on = { ev, fn }; } };
    try {
      const { layer, streets } = fakeLayer(source(new Set(), async () => {}).fn);
      delete layer._say;
      layer.badge.getContainer = () => el;
      const runs = countRuns(streets);
      await layer._update();
      assert.equal(el.textContent, "Street map known for 0 of 2 pieces here.");
      assert.equal(el.style.display, "");
      assert.equal(el.kids.length, 1);
      const [b] = el.kids;
      assert.deepEqual([b.tag, b.cls, b.type, b.textContent, b.on.ev], ["button", "streetsBadgeBtn", "button", "Download this area", "click"]);
      await b.on.fn();
      assert.equal(runs.n, 1);
      assert.equal(el.kids.length, 0, "a whole download clears the badge");
      assert.equal(el.style.display, "none");
    } finally { global.L.DomUtil = DomUtil; global.L.DomEvent = DomEvent; }
  }
  { // zoomed out while the download runs: progress does not overwrite the zoom-in text
    let release;
    const gate = new Promise((r) => { release = r; });
    const view = { b: TWO };
    const { layer, state } = fakeLayer(source(new Set(), () => gate).fn);
    layer._visibleTiles = () => tilesOf(view.b);
    await layer._update();
    const run = layer._download();
    view.b = BIG;
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
  { // a suggestion's run refreshes an expired tile the layer drew from: the lines are redrawn from the fresh ways only
    const KY = 110540, line = (id, y) => ({ id, nodes: [id, id + 1], geometry: [{ lat: 51 + y / KY, lon: 13.7 }, { lat: 51 + y / KY, lon: 13.7 + 400 / (111320 * Math.cos(51 * Math.PI / 180)) }] });
    const fetchStreets = async (tiles, kind, onTile, opts) => {
      const out = new Map();
      for (const t of tiles) {
        if (t.x !== 548) continue;
        const answer = { ways: [line(1, opts && opts.cacheOnly ? 100 : 300), ...(opts && opts.cacheOnly ? [line(5, 500)] : [])], groups: {} };
        if (opts && opts.cacheOnly) out.set(t.x + ":" + t.y, answer); else onTile(t, answer);
      }
      return out;
    };
    const { layer, streets } = fakeLayer(fetchStreets);
    delete layer._classifyNew;
    Object.assign(layer, { runs: [], doneRuns: [], _cursor: 0, isNew: (lon, lat) => lat > 51 + 250 / KY });
    await layer._update();
    const lats = (list = layer.runs) => [...new Set(list.map((r) => r.id + "@" + Math.round((r.ll[0][0] - 51) * KY)))].sort();
    assert.deepEqual([lats(), lats(layer.doneRuns)], [["5@500"], ["1@100"]], "drawn from the expired copy, way 1 already defogged");
    await streets.ensureRects([{ s: 51.0, w: 13.7, n: 51.025, e: 13.725 }], "run");
    await new Promise((r) => setTimeout(r, 20)); // onWaysChanged -> refresh() -> _update() repaints the layer; the timer lets that microtask run
    assert.deepEqual([lats(), lats(layer.doneRuns)], [["1@300"], []], "the replaced way is drawn once, at its new place, the dropped one is gone, and the defogged stretch of the old line no longer counts");
  }
  console.log("streets-layer-cache.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
