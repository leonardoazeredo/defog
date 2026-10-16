// Second wave of loop bearings and the shared direction helpers; synthetic streets, stubbed routing, no network.
//   node bench/loop-wave.test.js
"use strict";
const assert = require("node:assert/strict");
const { SuggestTool, StreetIndex } = require("./lib/load.js");
const { loopBearingOf, bearingApart } = SuggestTool._internals;

const KX = 111320 * Math.cos(51 * Math.PI / 180), KY = 110540;
const rad = (d) => d * Math.PI / 180;
const S0 = global.L.latLng(51, 13.7);
const ll = (x, y) => ({ lat: 51 + y / KY, lon: 13.7 + x / KX });
const at = (b, m) => global.L.latLng(51 + Math.cos(rad(b)) * m / KY, 13.7 + Math.sin(rad(b)) * m / KX);

// a 4 km x 1 km ring (10 km) pointing along bearing b: its farthest corner sits ~14 degrees past b
// fold: an out-and-back along the bearing, the kind of loop the >30% retrace filter drops
function ring(b, fold) {
  const u = [Math.sin(rad(b)), Math.cos(rad(b))], v = [Math.sin(rad(b + 90)), Math.cos(rad(b + 90))];
  const pt = (a, c) => [13.7 + (u[0] * a + v[0] * c) / KX, 51 + (u[1] * a + v[1] * c) / KY, 0];
  const out = [];
  if (fold) {
    const n = 100;
    for (let k = 0; k <= n; k++) out.push(pt(4900 * k / n, 0));
    for (let k = n; k >= 0; k--) out.push(pt(4900 * k / n, 20));
    out.push(pt(0, 0));
    return out;
  }
  const edge = (p, q) => { for (let k = 0; k < 40; k++) out.push(pt(p[0] + (q[0] - p[0]) * k / 40, p[1] + (q[1] - p[1]) * k / 40)); };
  edge([0, 0], [4000, 0]); edge([4000, 0], [4000, 1000]); edge([4000, 1000], [0, 1000]); edge([0, 1000], [0, 0]);
  out.push(pt(0, 0));
  return out;
}

async function run(routable, opts = {}) {
  const s = new StreetIndex({ newFrac: () => 1 });
  s._anchor(51);
  s._addWay({ id: 1, nodes: [1, 2], geometry: [ll(-3000, 0), ll(3000, 0)] });
  s.rects.push({ s: 50.9, n: 51.1, w: 13.6, e: 13.8, kind: "run" });
  const tool = new SuggestTool(global.fakeMap(), { fogMap: { tileCount: 0 }, computeGain: () => ({ area: 1e5, newPct: 100 }), isNew: () => true, streets: s });
  tool.mode = "loop"; tool.a = { getLatLng: () => S0 };
  tool._loopBearings = () => opts.bearings || [0, 60, 120, 180, 240, 300, 30, 90]; // synthetic list (the real one has at most 6); no planner plans here, so the first batch takes 6; the rest is the wave, which also retries the first batch as narrow and fat shapes
  // the single via encodes the bearing and, by its distance, the shape, so the route stub can read it back
  const VIA_M = { square: 100, narrow: 200, fat: 300, tri: 400 }; // the via distance tells the route stub which shape was asked
  tool._loopVias = (S, b, d, shape = "square") => {
    assert.ok(VIA_M[shape], `unknown shape ${shape}`); // Array.map must not leak its index in as the shape
    return [at(b, VIA_M[shape])];
  };
  tool._loopViasTri = (S, b) => [at(b, VIA_M.tri)];
  const asked = [];
  tool._route = async (wps) => {
    const v = wps[1];
    const b = Math.round((Math.atan2((v.lng - 13.7) * KX, (v.lat - 51) * KY) * 180 / Math.PI + 360) % 360);
    const shape = Object.keys(VIA_M).find((k) => Math.abs(Math.hypot((v.lat - 51) * KY, (v.lng - 13.7) * KX) - VIA_M[k]) < 5);
    asked.push(b + ":" + shape);
    if (!routable.includes(opts.byShape ? b + ":" + shape : b)) return null;
    const coords = ring(b, opts.fold && opts.fold.includes(b));
    const h = Math.floor(coords.length / 2);
    return { coords, lenM: 10000, legs: [{ coords: coords.slice(0, h) }, { coords: coords.slice(h - 1) }] };
  };
  let last = null;
  const progress = [];
  tool.onResults = (x) => { if (x && x.loading) progress.push(x); if (x && !x.loading) last = x; };
  await tool.suggest("hiking-mountain", { distM: 10000, buffer: 0.15 });
  return { last, tool, asked, progress };
}

(async () => {
  { // wave mechanics: nothing routes in the first batch, so the leftover bearings run and their loops are shown
    const { last, tool, asked } = await run([30, 90]);
    assert.ok(asked.includes('30:square') && asked.includes('90:square'), `asked ${asked}`);
    assert.equal(tool.results.length, 2, JSON.stringify(last && last.reason));
  }
  { // three directions already in: no extra wave
    const { asked, tool } = await run([0, 120, 240]);
    assert.equal(tool.results.length, 3);
    assert.ok(!asked.some((a) => a.startsWith('30:') || a.startsWith('90:')), `asked ${asked}`);
  }
  { // a bearing whose square never lands is retried as other shapes when too few directions came back
    const { asked, tool } = await run(["0:fat"], { bearings: [0], byShape: true });
    assert.ok(asked.includes("0:narrow") && asked.includes("0:fat"), `asked ${asked}`);
    assert.equal(tool.results.length, 1);
  }
  { // directions that retrace themselves are dropped later, so they must not stop the wave
    const { asked } = await run([0, 120, 240], { fold: [0, 120], bearings: [0, 120, 240] });
    assert.ok(asked.some((a) => a.endsWith(":narrow")), `asked ${asked}`);
  }
  { // ...and not when three directions are already in
    const { asked } = await run([0, 120, 240]);
    assert.ok(!asked.some((a) => a.endsWith(":narrow") || a.endsWith(":fat")), `asked ${asked}`);
  }
  { // another shape that fails to route is not retried as the triangle the first batch already tried
    const { asked } = await run([], { bearings: [0] });
    assert.equal(asked.filter((a) => a === "0:tri").length, 1, `asked ${asked}`);
  }
  { // the first-batch counter never grows or restarts; the wave reports on its own
    const { progress } = await run([30, 90]);
    const first = progress.filter((x) => x.phase === "loops"), more = progress.filter((x) => x.phase === "shapes");
    assert.ok(first.every((x) => x.total === first[0].total), "first-batch total changed");
    assert.ok(more.length > 0 && more[0].done === 0 && more[0].total > 0, JSON.stringify(more[0]));
  }
  { // shapes run one at a time: once one shape has brought three directions in, the next is not tried
    const { asked, tool } = await run(["0:narrow", "120:narrow", "240:narrow"], { bearings: [0, 120, 240], byShape: true });
    assert.equal(tool.results.length, 3);
    assert.ok(asked.includes("0:narrow") && !asked.some((a) => a.endsWith(":fat")), `asked ${asked}`);
  }
  { // the helpers _diversify uses
    const east = [[13.7, 51, 0], [13.7 + 3000 / KX, 51, 0], [13.7, 51, 0]];
    assert.ok(Math.abs(loopBearingOf(S0, east) - 90) < 1);
    assert.equal(bearingApart(350, 10), 20);
  }
  console.log("loop-wave.test.js ok");
})();
