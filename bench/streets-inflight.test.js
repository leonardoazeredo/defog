// StreetIndex.InFlight: the registry of tiles a running ensureRects is asking for; and GraphPlanner hold/release.
//   node bench/streets-inflight.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { StreetIndex, GraphPlanner } = global;

(async () => {
  const reg = new StreetIndex.InFlight();
  const t = { x: 5, y: 7 };
  assert.equal(reg.size, 0);
  assert.equal(reg.sharedFor("bike", t), undefined);
  const run = reg.claim(StreetIndex.tileKey("run", 5, 7));
  assert.equal(reg.size, 1);
  assert.equal(reg.sharedFor("run", t), run);
  assert.equal(reg.sharedFor("bike", t), run, "a run tile stands in for bike");
  assert.equal(reg.sharedFor("bike", { x: 5, y: 8 }), undefined);
  const bike = reg.claim(StreetIndex.tileKey("bike", 5, 7));
  assert.equal(reg.sharedFor("bike", t), bike, "the same kind is preferred");
  assert.equal(reg.sharedFor("run", t), run, "bike does not stand in for run");
  reg.settle(run, { cached: true });
  assert.deepEqual(await run.promise, { cached: true }, "waiters hear what the source said");
  assert.equal(reg.size, 1);
  const again = reg.claim(StreetIndex.tileKey("bike", 5, 7)); // a newer claim of the same tile replaces the entry
  reg.settle(bike, undefined);
  assert.equal(reg.size, 1, "settling an older claim leaves the newer one in place");
  assert.equal(reg.sharedFor("bike", t), again);
  reg.settle(again);
  assert.equal(reg.size, 0);

  const p = new GraphPlanner({ ways: [] }, () => 1);
  assert.equal(p.held, false);
  p.hold(); assert.equal(p.held, true);
  p.release(); assert.equal(p.held, false);
  console.log("streets-inflight: ok");
})().catch((e) => { console.error(e); process.exit(1); });
