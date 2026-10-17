// Overpass.post: endpoint order, fallback, backoff after 429/406, one request in flight; fakes.
//   node bench/overpass-endpoints.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { Overpass } = global;
const C = Overpass.ENDPOINTS.coffee, M = Overpass.ENDPOINTS.main;

let calls, replies, t;
const start = 1_000_000;
// replies: url -> queue of {status, headers?, body?}; an empty queue answers 200 with {"from": url}
function fakeFetch(url, opts) {
  calls.push(url);
  assert.equal(opts.method, "POST");
  const r = (replies[url] || []).shift() || { status: 200, body: { from: url } };
  const headers = r.headers || {};
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => r.body,
  });
}
function reset() {
  Overpass._reset();
  calls = []; replies = {}; t = start;
  Overpass._now = () => t;
  global.fetch = fakeFetch;
}
const rejection = (p) => p.then(() => assert.fail("expected a rejection"), (e) => e);

(async () => {
  { // 1. default order: private.coffee first
    reset();
    assert.deepEqual(await Overpass.post("data=x"), { from: C });
    assert.deepEqual(calls, [C]);
  }
  { // 2-4. a 429 falls through to main, blocks coffee for 30 s, then coffee is tried again
    reset();
    replies[C] = [{ status: 429 }];
    assert.deepEqual(await Overpass.post("data=x"), { from: M });
    assert.deepEqual(calls, [C, M]);
    calls = []; t = start + 10_000;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M], "coffee still blocked 10 s later");
    calls = []; t = start + 30_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C], "coffee usable again after 30 s");
  }
  { // 5. 406 is treated like 429
    reset();
    replies[C] = [{ status: 406 }];
    await Overpass.post("data=x");
    calls = []; t = start + 29_999;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 6. a longer Retry-After is honoured
    reset();
    replies[C] = [{ status: 429, headers: { "retry-after": "120" } }];
    await Overpass.post("data=x");
    calls = []; t = start + 60_000;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M], "still within Retry-After");
    calls = []; t = start + 120_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C]);
  }
  { // 7. every endpoint rate-limited: reject with retryAt, and send nothing until then
    reset();
    replies[C] = [{ status: 429 }];
    replies[M] = [{ status: 429 }];
    const e1 = await rejection(Overpass.post("data=x"));
    assert.equal(e1.retryAt, start + 30_000);
    assert.deepEqual(calls, [C, M]);
    t = start + 5_000;
    const e2 = await rejection(Overpass.post("data=x"));
    assert.equal(e2.retryAt, start + 30_000);
    assert.deepEqual(calls, [C, M], "no request while both are blocked");
  }
  { // 8. a 500 moves on at once and does not block the endpoint
    reset();
    replies[C] = [{ status: 500 }];
    assert.deepEqual(await Overpass.post("data=x"), { from: M });
    calls = [];
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C]);
  }
  { // 8b. every endpoint failing without a block rejects with no retryAt
    reset();
    replies[C] = [{ status: 500 }];
    replies[M] = [{ status: 504 }];
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.retryAt, undefined);
    assert.match(e.message, /504/);
  }
  { // 9. the order is a setting
    reset();
    Overpass.setOrder(["main", "coffee"]);
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 10. an order naming no known endpoint is ignored
    reset();
    Overpass.setOrder(["nope"]);
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C]);
  }
  { // 11. one request in flight: a second post() waits until the first has its answer
    reset();
    let release;
    let inFlight = 0, maxInFlight = 0;
    global.fetch = (url, opts) => {
      calls.push(url);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const done = () => { inFlight--; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ from: url }) }; };
      return calls.length === 1 ? new Promise((r) => { release = () => r(done()); }) : Promise.resolve(done());
    };
    const first = Overpass.post("data=a");
    const second = Overpass.post("data=b");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1, "the second request waits");
    release();
    await Promise.all([first, second]);
    assert.equal(calls.length, 2);
    assert.equal(maxInFlight, 1);
  }
  console.log("overpass-endpoints.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
