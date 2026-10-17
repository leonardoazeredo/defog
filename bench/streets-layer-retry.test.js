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
  console.log("streets-layer-retry.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
