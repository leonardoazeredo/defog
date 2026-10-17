// Overpass.post: endpoint order, fallback, one request in flight, timeouts; holds after 429/406,
// failed fetches and stalled bodies; no hold after a 500 or a non-JSON 200. Fake fetch, fake clock.
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
// A post() that never settles leaves nothing scheduled, and Node would exit 0 without a verdict.
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) { console.error("overpass-endpoints.test.js did not finish"); process.exitCode = 1; }
});

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
  { // 12. a request that never settles times out; the next endpoint answers and later posts go out
    reset();
    Overpass._timeoutMs = 20;
    let signalled = true;
    global.fetch = (url, opts) => {
      calls.push(url);
      if (!opts.signal) { signalled = false; return Promise.reject(new Error("no abort signal")); }
      if (url === C) return new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason)));
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ from: url }) });
    };
    // Node's AbortSignal.timeout timer does not keep the process alive; this one does.
    const keepAlive = setTimeout(() => {}, 5_000);
    assert.deepEqual(await Overpass.post("data=x"), { from: M });
    clearTimeout(keepAlive);
    assert.ok(signalled, "every request carries an abort signal");
    assert.deepEqual(calls, [C, M]);
    calls = [];
    assert.deepEqual(await Overpass.post("data=y"), { from: M }, "the queue is not stuck");
    assert.deepEqual(calls, [M], "the stalled endpoint is on hold");
  }
  { // 13. a failure the page cannot read holds that endpoint 30 s
    //     (a TypeError, which is also how a 429 without CORS headers arrives)
    reset();
    global.fetch = (url) => {
      calls.push(url);
      if (url === C) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ from: url }) });
    };
    assert.deepEqual(await Overpass.post("data=x"), { from: M });
    calls = []; t = start + 29_999;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
    calls = []; t = start + 30_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C, M]);
  }
  { // 14. every endpoint unreachable: reject with the last fetch error and retryAt;
    //     nothing is sent before then
    reset();
    global.fetch = (url) => { calls.push(url); return Promise.reject(new TypeError("Failed to fetch")); };
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.retryAt, start + 30_000);
    assert.match(e.message, /Failed to fetch/);
    assert.doesNotMatch(e.message, /rate-limited/);
    t = start + 1_000;
    await rejection(Overpass.post("data=x"));
    assert.deepEqual(calls, [C, M]);
  }
  // 15. a 200 whose body is not JSON (a captive portal, a proxy's error page) moves on to the next
  //     endpoint at once and, like a 500, puts no hold on the first; Chromium and Node reject with
  //     a SyntaxError, WebKit with a DOMException named SyntaxError
  for (const notJson of [new SyntaxError("Unexpected token '<'"), new DOMException("The string did not match the expected pattern.", "SyntaxError")]) {
    reset();
    global.fetch = (url) => {
      calls.push(url);
      const json = url === C ? async () => { throw notJson; } : async () => ({ from: url });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json });
    };
    assert.deepEqual(await Overpass.post("data=x"), { from: M });
    calls = [];
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C, M], "coffee is not on hold after a " + notJson.constructor.name);
  }
  { // 16. the timeout fires while the body is still arriving: the next endpoint answers and the
    //     stalled one is on hold
    reset();
    Overpass._timeoutMs = 20;
    global.fetch = (url, opts) => {
      calls.push(url);
      const json = url === C
        ? () => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason)))
        : async () => ({ from: url });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json });
    };
    const keepAlive = setTimeout(() => {}, 5_000); // the abort timer does not keep Node alive (case 12)
    assert.deepEqual(await Overpass.post("data=x"), { from: M });
    calls = [];
    await Overpass.post("data=y");
    clearTimeout(keepAlive);
    assert.deepEqual(calls, [M], "the stalled endpoint is on hold");
  }
  finished = true;
  console.log("overpass-endpoints.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
