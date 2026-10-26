// StreetsInFogLayer._update: a rate-limited Overpass gets no request before retryAt; fake streets.
//   node bench/streets-layer-retry.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
global.L.Control = global.L.Control || { extend: () => function () {} };
require("../app/src/streetsLayer.js");
const { StreetsInFogLayer } = global;

function fakeLayer(fail) {
  const layer = Object.create(StreetsInFogLayer.prototype);
  const state = { calls: 0, said: [] };
  Object.assign(layer, {
    enabled: true, _busy: false, _dirty: false, _retryAt: 0,
    _visibleTiles: () => [{ s: 51, n: 51.05, w: 13.7, e: 13.75 }],
    _say: (m) => state.said.push(m),
    _classifyNew: async () => {}, _draw: () => {},
    streets: { needsFetch: () => true, ensureRects: async () => { state.calls++; throw fail(); } }
  });
  return { layer, state };
}

(async () => {
  { // every endpoint rate-limited: no quiet retry, and nothing is asked before retryAt
    const retryAt = Date.now() + 60_000;
    const { layer, state } = fakeLayer(() => Object.assign(new Error("overpass HTTP 429"), { retryAt }));
    await layer._update();
    assert.equal(state.calls, 1, "a rate-limited Overpass gets no quiet retry");
    assert.ok(layer._retryAt >= retryAt, "the layer waits at least until the error's retryAt");
    await layer._update();
    assert.equal(state.calls, 1, "a map move before retryAt sends nothing");
  }
  { // a plain failure gets one quiet retry, then the RETRY_MS cooldown
    const { layer, state } = fakeLayer(() => new Error("overpass HTTP 504"));
    const before = Date.now();
    await layer._update();
    assert.equal(state.calls, 2, "one quiet retry after a plain failure");
    assert.ok(layer._retryAt >= before + 10_000 && layer._retryAt < before + 60_000);
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
