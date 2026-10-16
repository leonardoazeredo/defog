// Pure-logic checks for fitLoopSize, the bracketed size search behind compass-square loops; no network, no fog.
//   node bench/loop-fit.test.js
"use strict";
const assert = require("node:assert/strict");
const { SuggestTool } = require("./lib/load.js");
const { fitLoopSize, FIT_ROUTES } = SuggestTool._internals;

const D = 10000, BUF = 0.15, never = () => false;
const rec = (len) => { const calls = []; return { calls, prep: async (d) => { calls.push(d); return len(d); } }; };
const ok = (lenM, blockedM = 0) => ({ r: { lenM }, blockedM });

(async () => {
  { // proportional: first attempt 2.5x too long lands in the window within three routes
    const { calls, prep } = rec((d) => ok(4 * d));
    const first = await prep(6250);
    const c = await fitLoopSize(prep, 6250, first, D, BUF, never);
    assert.ok(Math.abs(c.r.lenM - D) <= 1500, `len ${c.r.lenM}`);
    assert.ok(calls.length <= 3, `calls ${calls.length}`);
  }
  { // length jumps at dim 2000 (a barrier): the window is unreachable, so stop within budget on the closest
    const { calls, prep } = rec((d) => ok(d < 2000 ? 4 * d : 4 * d + 6000));
    const first = await prep(6250);
    const c = await fitLoopSize(prep, 6250, first, D, BUF, never);
    assert.ok(calls.length <= FIT_ROUTES, `calls ${calls.length}`);
    assert.equal(new Set(calls).size, calls.length, "a dim was routed twice");
    assert.ok(Math.abs(c.r.lenM - D) <= 2100, `len ${c.r.lenM}`);
  }
  { // nothing routes above dim 2800: a null bounds the search instead of ending it
    const { calls, prep } = rec((d) => (d > 2800 ? null : ok(3.5 * d)));
    const first = await prep(500);
    const c = await fitLoopSize(prep, 500, first, D, BUF, never);
    assert.ok(c && c.r.lenM >= D * (1 - BUF) && c.r.lenM <= D * (1 + BUF), `len ${c && c.r.lenM}`);
    assert.ok(calls.length <= FIT_ROUTES, `calls ${calls.length}`);
  }
  { // a cancelled run stops routing after the call in flight
    const { calls, prep } = rec(() => ok(30000));
    const first = await prep(6250);
    await fitLoopSize(prep, 6250, first, D, BUF, () => calls.length > 1);
    assert.equal(calls.length, 2);
  }
  { // an in-tolerance loop with a floor-blocked snip is regrown by the blocked amount and the clean one wins
    const { calls, prep } = rec((d) => ok(d * 2, 0));
    const first = ok(10000, 800);
    const c = await fitLoopSize(prep, 5000, first, D, BUF, never);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 5000 * 1.08);
    assert.equal(c.blockedM, 0);
  }
  { // never in range: exactly the budget, minus the first route
    const { calls, prep } = rec(() => ok(30000));
    await fitLoopSize(prep, 6250, ok(30000), D, BUF, never);
    assert.equal(calls.length, FIT_ROUTES - 1);
  }
  console.log("loop-fit.test.js ok");
})();
