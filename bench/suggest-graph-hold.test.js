// A suggestion plans on one graph from its first route to its last, while streets another run merges
// meanwhile reach the route editor at once; synthetic streets, no network.
//   node bench/suggest-graph-hold.test.js
"use strict";
const assert = require("node:assert/strict");
const { SuggestTool, StreetIndex } = require("./lib/load.js");

const KX = 111320 * Math.cos(51 * Math.PI / 180), KY = 110540;
const ll = (x, y) => ({ lat: 51 + y / KY, lon: 13.7 + x / KX });
const pin = (x, y) => { const p = global.L.latLng(51 + y / KY, 13.7 + x / KX); return { getLatLng: () => p }; };

function streetsWith(ways) {
  const s = new StreetIndex({ newFrac: () => 1 });
  s._anchor(51);
  for (const [id, nodes, p, q] of ways) s._addWay({ id, nodes, geometry: [ll(...p), ll(...q)] });
  s._cover(StreetIndex.tilesCovering({ s: 50.9, n: 51.1, w: 13.6, e: 13.8 }), "run");
  return s;
}
const street = [[1, [1, 2], [0, 0], [500, 0]], [2, [2, 3], [500, 0], [1000, 0]], [3, [1, 4], [0, 0], [0, 300]], [4, [4, 3], [0, 300], [1000, 0]]];

(async () => {
  const s = streetsWith(street);
  const tool = new SuggestTool(global.fakeMap(), { fogMap: { tileCount: 0 }, computeGain: () => ({ area: 1, newPct: 1 }), streets: s });
  tool.mode = "p2p"; tool.a = pin(0, 0); tool.b = pin(1000, 0);
  const route = global.LocalRouter.prototype.route;
  const seen = [];
  let editor = null;
  global.LocalRouter.prototype.route = function (...args) {
    const out = route.apply(this, args);
    seen.push([this.planner, this.planner.builtStamp, this.planner.edges.length]);
    if (seen.length === 1) {
      // another run's tile lands between two of the suggestion's routes
      s._addWay({ id: 9, nodes: [3, 9], geometry: [ll(1000, 0), ll(1500, 0)] });
      s.version++;
      editor = tool.plannerFor("hiking-mountain");
      editor.build();
    }
    return out;
  };
  await tool.suggest("hiking-mountain", { buffer: 0.15 });
  global.LocalRouter.prototype.route = route;
  assert.ok(seen.length > 1, `routes ${seen.length}`);
  assert.ok(seen.every(([p, stamp]) => p === seen[0][0] && stamp === seen[0][1]), "one graph for the whole suggestion");
  assert.notEqual(editor, seen[0][0], "the editor is not handed the graph the suggestion holds");
  assert.equal(editor.edges.length, seen[0][2] + 1, "the editor's graph has the new street");
  const after = tool.plannerFor("hiking-mountain");
  after.build();
  assert.equal(after.edges.length, seen[0][2] + 1, "once the suggestion ends, its graph is current again");
  assert.equal(after.held, false);

  { // a run cancelled while it holds a graph lets go of it
    const t = new SuggestTool(global.fakeMap(), { fogMap: { tileCount: 0 }, computeGain: () => ({ area: 1, newPct: 1 }), streets: streetsWith(street) });
    t.mode = "p2p"; t.a = pin(0, 0); t.b = pin(1000, 0);
    let held = null;
    const orig = t._route;
    t._route = async function (...a) { held = held || this._graphFor("hiking-mountain"); this.clearResults(); return orig.apply(this, a); };
    await t.suggest("hiking-mountain", { buffer: 0.15 });
    assert.equal(held.held, false);
  }
  { // an older run that ends while a newer one plans leaves the newer run's graph held
    const st = streetsWith(street);
    const t = new SuggestTool(global.fakeMap(), { fogMap: { tileCount: 0 }, computeGain: () => ({ area: 1, newPct: 1 }), streets: st });
    t.mode = "p2p"; t.a = pin(0, 0); t.b = pin(1000, 0);
    let openOld, openNew;
    const oldGate = new Promise((r) => { openOld = r; }), newGate = new Promise((r) => { openNew = r; });
    let calls = 0;
    st.ensureRects = async () => { if (++calls === 1) await oldGate; return { done: 1, total: 1, missing: [] }; };
    const orig = t._route;
    let parked = null;
    t._route = async function (...a) {
      if (!parked) { parked = this._hold; await newGate; }
      return orig.apply(this, a);
    };
    const older = t.suggest("hiking-mountain", { buffer: 0.15 });
    const newer = t.suggest("hiking-mountain", { buffer: 0.15 });
    await new Promise((r) => setImmediate(r));
    assert.ok(parked && parked.planner.held, "the newer run holds its graph");
    openOld();
    await older;
    assert.equal(t._hold, parked, "still the newer run's");
    assert.equal(parked.planner.held, true);
    openNew();
    await newer;
    assert.equal(t._hold, null);
  }
  console.log("suggest-graph-hold: ok");
})().catch((e) => { console.error(e); process.exit(1); });
