// StreetsInFogLayer._update: a rate-limited Overpass gets no request before retryAt; fake streets.
//   node bench/streets-layer-retry.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
global.L.Control = global.L.Control || { extend: () => function () {} };
require("../app/src/streetsLayer.js");
const { StreetsInFogLayer, StreetIndex } = global;

// A layer on a fake clock: waiting moves the clock and is recorded, so no test waits on real time.
function fakeLayer(fail) {
  const layer = Object.create(StreetsInFogLayer.prototype);
  const clock = { t: 0 };
  const state = { calls: 0, said: [], slept: [], drawn: 0 };
  Object.assign(layer, {
    enabled: true, _busy: false, _dirty: false, _retryAt: 0,
    _now: () => clock.t,
    _sleep: async (ms) => { state.slept.push(ms); clock.t += ms; },
    _visibleTiles: () => [{ s: 51, n: 51.05, w: 13.7, e: 13.75 }],
    _say: (m) => state.said.push(m),
    _classifyNew: async () => {}, _draw: () => { state.drawn++; },
    streets: { needsFetch: () => true, ensureRects: async () => { state.calls++; throw fail(); } }
  });
  return { layer, state, clock };
}

(async () => {
  { // every endpoint rate-limited: no quiet retry, and nothing is asked before retryAt
    const retryAt = 60_000;
    const { layer, state } = fakeLayer(() => Object.assign(new Error("overpass HTTP 429"), { retryAt }));
    await layer._update();
    assert.equal(state.calls, 1, "a rate-limited Overpass gets no quiet retry");
    assert.ok(layer._retryAt >= retryAt, "the layer waits at least until the error's retryAt");
    await layer._update();
    assert.equal(state.calls, 1, "a map move before retryAt sends nothing");
  }
  { // a plain failure gets one quiet retry 3 s later, then the 10 s cooldown
    const { layer, state } = fakeLayer(() => new Error("overpass HTTP 504"));
    await layer._update();
    assert.equal(state.calls, 2, "one quiet retry after a plain failure");
    assert.deepEqual(state.slept, [3000]);
    assert.equal(layer._retryAt, 3000 + 10_000);
  }
  { // a partial failure gets the quiet retry too, and the retry asks only for the tiles that did not come
    const asked = [];
    let failOnce = true;
    const fetchStreets = async (tiles, kind, onTile) => {
      asked.push(tiles.map((t) => t.x + ":" + t.y));
      const out = new Map();
      for (const t of tiles) {
        if (failOnce && out.size === 1) { failOnce = false; throw Object.assign(new Error("overpass HTTP 504"), { reason: "busy" }); }
        const answer = { ways: [], groups: {} };
        out.set(t.x + ":" + t.y, answer);
        onTile(t, answer);
      }
      return out;
    };
    const { layer, state } = fakeLayer();
    const streets = new StreetIndex({ newFrac: () => 1, fetchStreets });
    const ensure = streets.ensureRects.bind(streets);
    const errors = [];
    streets.ensureRects = (...a) => ensure(...a).catch((e) => { errors.push(e); throw e; });
    layer.streets = streets;
    const tiles = StreetIndex.tilesCovering({ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }).map(StreetIndex.tileBounds);
    assert.equal(tiles.length, 2);
    layer._visibleTiles = () => tiles;
    await layer._update();
    assert.deepEqual(errors.map((e) => [e.done, e.total, e.reason]), [[1, 2, "streets-partial"]]);
    assert.deepEqual(state.slept, [3000]);
    assert.equal(asked.length, 2);
    assert.deepEqual(asked[1], asked[0].slice(1), "the retry asks only for the missing tile");
    assert.deepEqual([state.drawn, layer._retryAt], [1, 0]);
  }
  { // a 48-tile view on the 0.025° grid is still fetched; a larger one asks to zoom in
    assert.equal(StreetsInFogLayer.MAX_TILES, 48);
    const view = (b) => ({ getBounds: () => ({ getSouth: () => b.s, getWest: () => b.w, getNorth: () => b.n, getEast: () => b.e }) });
    const ok = fakeLayer(() => new Error("overpass HTTP 504"));
    delete ok.layer._visibleTiles;
    ok.layer.map = view({ s: 51.0, w: 13.7, n: 51.15, e: 13.9 });
    ok.layer.streets.ensureRects = async (tiles) => { ok.state.calls++; ok.state.tiles = tiles.length; };
    await ok.layer._update();
    assert.deepEqual([ok.state.calls, ok.state.tiles], [1, 48]);
    const big = fakeLayer(() => new Error("overpass HTTP 504"));
    delete big.layer._visibleTiles;
    big.layer.map = view({ s: 51.0, w: 13.7, n: 51.16, e: 13.9 });
    big.layer.dim = big.layer.halo = big.layer.core = { setLatLngs: () => {} };
    await big.layer._update();
    assert.equal(big.state.calls, 0);
    assert.match(big.state.said.pop(), /Zoom in/);
  }
  console.log("streets-layer-retry.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
