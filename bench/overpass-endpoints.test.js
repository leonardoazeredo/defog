// Overpass.post: endpoint order, fallback, one request in flight, the first-byte and body guards;
// holds after a 429 (30 s) and a 406 (an hour), each longer with Retry-After, a failed fetch and
// a stall (30 s, ten minutes from the third stall in a row); no hold after a 500 or a non-JSON
// 200; the rejection's reason.
// Fake fetch, fake clock, fake timers: nothing here waits on real time.
//   node bench/overpass-endpoints.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
require("../app/src/streetMessages.js");
const { Overpass, StreetIndex, StreetMessages } = global;
const C = Overpass.ENDPOINTS.coffee, M = Overpass.ENDPOINTS.main;
const REASONS = ["blocked", "busy", "stalled", "offline", "server"];

let calls, replies, t, timers;
const start = 1_000_000;
const headers = (h = {}) => ({ get: (k) => h[k.toLowerCase()] ?? null });
// replies: url -> queue of {status, headers?, body?}; an empty queue answers 200 with {"from": url}
function fakeFetch(url, opts) {
  calls.push(url);
  assert.equal(opts.method, "POST");
  assert.ok(opts.signal, "every request carries an abort signal");
  const r = (replies[url] || []).shift() || { status: 200, body: { from: url } };
  return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: headers(r.headers), json: async () => r.body });
}
// Endpoint behaviours for a routed fetch (url -> behaviour), each recorded in calls.
const answer = (url) => Promise.resolve({ ok: true, status: 200, headers: headers(), json: async () => ({ from: url }) });
const status = (code) => () => Promise.resolve({ ok: false, status: code, headers: headers(), json: async () => null });
const notJson = () => Promise.resolve({ ok: true, status: 200, headers: headers(), json: async () => { throw new SyntaxError("Unexpected token '<'"); } });
const unreachable = () => Promise.reject(new TypeError("Failed to fetch"));
// no headers ever: settles only when the client aborts it
const silent = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason)));
// headers at once, then a body that never ends
const headersOnly = (url, opts) => Promise.resolve({ ok: true, status: 200, headers: headers(), json: () => silent(url, opts) });
function routed(table) {
  return (url, opts) => { calls.push(url); assert.ok(opts.signal, "every request carries an abort signal"); return table[url](url, opts); };
}
function reset() {
  Overpass._reset();
  calls = []; replies = {}; t = start; timers = [];
  Overpass._now = () => t;
  Overpass._setTimeout = (fn, ms) => { const timer = { fn, at: t + ms }; timers.push(timer); return timer; };
  Overpass._clearTimeout = (timer) => { timers = timers.filter((x) => x !== timer); };
  global.fetch = fakeFetch;
}
// lets everything the last event triggered run (promise chains settle before a macrotask)
const settle = () => new Promise((r) => setImmediate(r));
// moves the clock and fires the timers that come due on the way, with a settle after each so the
// code reacting to one has run before the next fires
async function advance(ms) {
  const until = t + ms;
  for (;;) {
    const next = timers.filter((x) => x.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    t = next.at; timers = timers.filter((x) => x !== next); next.fn();
    await settle();
  }
  t = until;
}
// a post whose stalls are played out on the clock (each endpoint gets at most 30 s, so two minutes covers any order)
async function played(p) { await settle(); await advance(120_000); return p; }
const rejection = (p) => p.then(() => assert.fail("expected a rejection"), (e) => {
  assert.ok(REASONS.includes(e.reason), "the reason is one of five words, got " + JSON.stringify(e.reason));
  return e;
});
// A post() that never settles leaves nothing scheduled, and Node would exit 0 without a verdict.
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) { console.error("overpass-endpoints.test.js did not finish"); process.exitCode = 1; }
});

(async () => {
  { // 1. default order: overpass-api.de first
    reset();
    assert.deepEqual(await Overpass.post("data=x"), { from: M });
    assert.deepEqual(calls, [M]);
  }
  { // 2-4. a 429 falls through to coffee, holds main for 30 s (not the hour a 406 earns), then main is tried again
    reset();
    replies[M] = [{ status: 429 }];
    assert.deepEqual(await Overpass.post("data=x"), { from: C });
    assert.deepEqual(calls, [M, C]);
    calls = []; t = start + 10_000;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C], "main still on hold 10 s later");
    calls = []; t = start + 30_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M], "main usable again after 30 s");
  }
  { // 5. a 406 is the day's block: the endpoint is held an hour and the rejection says blocked
    reset();
    replies[M] = [{ status: 406 }]; replies[C] = [{ status: 500 }];
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.reason, "blocked");
    assert.equal(e.retryAt, undefined, "a 500 puts no hold on coffee");
    calls = []; t = start + 3_599_999;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C], "main still blocked just under an hour later");
    calls = []; t = start + 3_600_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 6. a longer Retry-After is honoured
    reset();
    replies[M] = [{ status: 429, headers: { "retry-after": "120" } }];
    await Overpass.post("data=x");
    calls = []; t = start + 60_000;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C], "still within Retry-After");
    calls = []; t = start + 120_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 7. every endpoint rate-limited: reject with retryAt and busy, and send nothing until then
    reset();
    replies[M] = [{ status: 429 }];
    replies[C] = [{ status: 429 }];
    const e1 = await rejection(Overpass.post("data=x"));
    assert.equal(e1.retryAt, start + 30_000);
    assert.equal(e1.reason, "busy");
    assert.deepEqual(calls, [M, C]);
    t = start + 5_000;
    const e2 = await rejection(Overpass.post("data=x"));
    assert.equal(e2.retryAt, start + 30_000);
    assert.equal(e2.reason, "busy", "the holds remember why");
    assert.deepEqual(calls, [M, C], "no request while both are blocked");
  }
  { // 8. a 500 moves on at once and does not block the endpoint
    reset();
    replies[M] = [{ status: 500 }];
    assert.deepEqual(await Overpass.post("data=x"), { from: C });
    calls = [];
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 8b. every endpoint failing without a block rejects with no retryAt; a 504 is the server being busy
    reset();
    replies[M] = [{ status: 500 }];
    replies[C] = [{ status: 504 }];
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.retryAt, undefined);
    assert.equal(e.reason, "busy");
    assert.match(e.message, /504/);
  }
  { // 9. the order is a setting
    reset();
    Overpass.setOrder(["coffee", "main"]);
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C]);
  }
  { // 10. an order naming no known endpoint is ignored
    reset();
    Overpass.setOrder(["nope"]);
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 11. one request in flight: a second post() waits until the first has its answer
    reset();
    let release;
    let inFlight = 0, maxInFlight = 0;
    global.fetch = (url, opts) => {
      calls.push(url);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const done = () => { inFlight--; return { ok: true, status: 200, headers: headers(), json: async () => ({ from: url }) }; };
      return calls.length === 1 ? new Promise((r) => { release = () => r(done()); }) : Promise.resolve(done());
    };
    const first = Overpass.post("data=a");
    const second = Overpass.post("data=b");
    await settle();
    assert.equal(calls.length, 1, "the second request waits");
    release();
    await Promise.all([first, second]);
    assert.equal(calls.length, 2);
    assert.equal(maxInFlight, 1);
  }
  { // 12. an endpoint that sends no byte is abandoned at 15 s on the clock, the next one is asked in
    //     the same post, and the silent one is held exactly 30 s from the moment it was abandoned
    reset();
    const table = { [M]: silent, [C]: answer };
    global.fetch = routed(table);
    const p = Overpass.post("data=x");
    await settle(); await advance(14_999);
    assert.deepEqual(calls, [M], "still waiting just under 15 s");
    await advance(1);
    assert.deepEqual(calls, [M, C], "abandoned at 15 s; coffee asked in the same post");
    assert.deepEqual(await p, { from: C });
    assert.equal(t, start + 15_000);
    calls = []; t = start + 15_000 + 29_999;
    assert.deepEqual(await Overpass.post("data=y"), { from: C }, "the queue is not stuck");
    assert.deepEqual(calls, [C], "the silent endpoint is on hold");
    calls = []; t = start + 15_000 + 30_001; table[M] = answer;
    await Overpass.post("data=z");
    assert.deepEqual(calls, [M], "a single stall holds 30 s, no longer");
  }
  // a post that stalls on main and completes on coffee, played out on the clock
  const stallOnce = async () => {
    const p = Overpass.post("data=x");
    await settle(); await advance(15_000);
    assert.deepEqual(await p, { from: C });
  };
  { // 12b. the third stall in a row holds the endpoint ten minutes, and so does every one after it
    reset();
    const table = { [M]: silent, [C]: answer };
    global.fetch = routed(table);
    await stallOnce();
    t += 30_001; await stallOnce();
    calls = []; t += 29_999; await Overpass.post("data=x");
    assert.deepEqual(calls, [C], "the second stall still holds only 30 s");
    t += 2; await stallOnce();
    const third = t;
    calls = []; t = third + 599_999; await Overpass.post("data=x");
    assert.deepEqual(calls, [C], "held ten minutes after the third stall in a row");
    t = third + 600_001; await stallOnce();
    const fourth = t;
    calls = []; t = fourth + 599_999; await Overpass.post("data=x");
    assert.deepEqual(calls, [C], "the fourth stall in a row holds ten minutes too");
    calls = []; t = fourth + 600_001; table[M] = answer; await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 12c. any answer that ends, even a 500, resets the count: stall, stall, 500, stall holds 30 s
    reset();
    const table = { [M]: silent, [C]: answer };
    global.fetch = routed(table);
    await stallOnce();
    t += 30_001; await stallOnce();
    t += 30_001; table[M] = status(500);
    assert.deepEqual(await Overpass.post("data=x"), { from: C });
    table[M] = silent; await stallOnce();
    calls = []; t += 30_001; table[M] = answer; await Overpass.post("data=x");
    assert.deepEqual(calls, [M], "the stall after the status was the first of a new run");
  }
  { // 13. a failure the page cannot read (a TypeError, which is also how a 429 without CORS headers
    //     arrives) holds that endpoint 30 s and does not count as a stall
    reset();
    const table = { [M]: unreachable, [C]: answer };
    global.fetch = routed(table);
    assert.deepEqual(await Overpass.post("data=x"), { from: C });
    calls = []; t = start + 29_999;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C]);
    calls = []; t = start + 30_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M, C]);
    table[M] = silent; t += 30_001; await stallOnce();
    t += 30_001; await stallOnce();
    calls = []; t += 30_001; table[M] = answer; await Overpass.post("data=x");
    assert.deepEqual(calls, [M], "two stalls after a failed fetch: still a 30 s hold");
  }
  { // 14. every endpoint unreachable: reject with the last fetch error, offline and retryAt;
    //     nothing is sent before then
    reset();
    global.fetch = routed({ [M]: unreachable, [C]: unreachable });
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.retryAt, start + 30_000);
    assert.equal(e.reason, "offline");
    assert.match(e.message, /Failed to fetch/);
    t = start + 1_000;
    const e2 = await rejection(Overpass.post("data=x"));
    assert.equal(e2.reason, "offline", "the holds remember why");
    assert.deepEqual(calls, [M, C]);
  }
  // 15. a 200 whose body is not JSON (a captive portal, a proxy's error page) moves on to the next
  //     endpoint at once and, like a 500, puts no hold on the first; Chromium and Node reject with
  //     a SyntaxError, WebKit with a DOMException named SyntaxError
  for (const bad of [new SyntaxError("Unexpected token '<'"), new DOMException("The string did not match the expected pattern.", "SyntaxError")]) {
    reset();
    global.fetch = routed({ [M]: () => Promise.resolve({ ok: true, status: 200, headers: headers(), json: async () => { throw bad; } }), [C]: answer });
    assert.deepEqual(await Overpass.post("data=x"), { from: C });
    calls = [];
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M, C], "main is not on hold after a " + bad.constructor.name);
  }
  { // 16. a body that stops after the headers is abandoned 30 s after the request began: the 15 s
    //     first-byte guard ends when the headers arrive, and the body then runs to the 30 s limit
    //     from the request start; the endpoint is held 30 s
    reset();
    const table = { [M]: headersOnly, [C]: answer };
    global.fetch = routed(table);
    const p = Overpass.post("data=x");
    await settle(); await advance(29_999);
    assert.deepEqual(calls, [M], "the body has until 30 s");
    await advance(1);
    assert.deepEqual(calls, [M, C]);
    assert.deepEqual(await p, { from: C });
    calls = []; t += 29_999; await Overpass.post("data=y");
    assert.deepEqual(calls, [C], "the stalled endpoint is on hold");
    calls = []; t += 2; table[M] = answer; await Overpass.post("data=y");
    assert.deepEqual(calls, [M]);
  }
  { // 16c. a body stall's 200 does not end the answer, so it does not reset the count: the third
    //     body stall in a row holds the endpoint ten minutes
    reset();
    const table = { [M]: headersOnly, [C]: answer };
    global.fetch = routed(table);
    const bodyStall = async () => {
      const p = Overpass.post("data=x");
      await settle(); await advance(30_000);
      assert.deepEqual(await p, { from: C });
    };
    await bodyStall();
    t += 30_001; await bodyStall();
    t += 30_001; await bodyStall();
    const third = t;
    calls = []; t = third + 599_999; await Overpass.post("data=x");
    assert.deepEqual(calls, [C], "held ten minutes after the third body stall in a row");
    calls = []; t = third + 600_001; table[M] = answer; await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 16b. headers that arrive at 10 s leave the body 20 s: abandoned at 30 s total
    reset();
    let release;
    const late = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
      release = () => resolve({ ok: true, status: 200, headers: headers(), json: () => silent(url, opts) });
    });
    global.fetch = routed({ [M]: late, [C]: answer });
    const p = Overpass.post("data=x");
    await settle(); await advance(10_000); release(); await settle();
    await advance(19_999);
    assert.deepEqual(calls, [M]);
    await advance(1);
    assert.deepEqual(calls, [M, C]);
    assert.deepEqual(await p, { from: C });
  }
  { // 17. the reason is the most actionable of what the endpoints said:
    //     blocked over busy over stalled over offline over server
    const cases = [
      [{ [M]: status(406), [C]: status(429) }, "blocked"],
      [{ [M]: status(429), [C]: status(406) }, "blocked"],
      [{ [M]: status(429), [C]: silent }, "busy"],
      [{ [M]: silent, [C]: status(502) }, "busy"],
      [{ [M]: status(502), [C]: status(500) }, "busy"],
      [{ [M]: silent, [C]: unreachable }, "stalled"],
      [{ [M]: headersOnly, [C]: status(500) }, "stalled"],
      [{ [M]: unreachable, [C]: unreachable }, "offline"],
      [{ [M]: unreachable, [C]: status(500) }, "server"], // a status was seen: the network is up
      [{ [M]: status(500), [C]: notJson }, "server"],
      [{ [M]: status(400), [C]: status(500) }, "server"]
    ];
    for (const [table, want] of cases) {
      reset();
      global.fetch = routed(table);
      const e = await rejection(played(Overpass.post("data=x")));
      assert.equal(e.reason, want, Object.values(table).map((f) => f.name || "status").join(" + "));
    }
  }
  { // 17b. the browser saying it is offline outranks a server error, not a block
    for (const [table, want] of [[{ [M]: status(500), [C]: status(500) }, "offline"], [{ [M]: status(406), [C]: status(500) }, "blocked"]]) {
      reset();
      global.fetch = routed(table);
      Object.defineProperty(global.navigator, "onLine", { value: false, configurable: true });
      try {
        assert.equal((await rejection(Overpass.post("data=x"))).reason, want);
      } finally { delete global.navigator.onLine; }
    }
  }
  { // 18. with every endpoint on hold nothing is sent; the rejection carries retryAt and the holds' reason
    reset();
    replies[M] = [{ status: 406 }]; replies[C] = [{ status: 429 }];
    await rejection(Overpass.post("data=x"));
    calls = []; t = start + 10_000;
    const e = await rejection(Overpass.post("data=x"));
    assert.deepEqual(calls, []);
    assert.equal(e.reason, "blocked");
    assert.equal(e.retryAt, start + 3_600_000, "blocked: the retry time is the block's hour, not coffee's 30 s");
    calls = []; t = start + 30_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [C], "coffee itself is still asked again after its 30 s");
  }
  { // a 406 on main, then coffee silent: blocked wins, and the error is main's 406, not coffee's silence
    reset();
    global.fetch = routed({ [M]: status(406), [C]: silent });
    const e = await rejection(played(Overpass.post("data=x")));
    assert.deepEqual(calls, [M, C]);
    assert.equal(e.reason, "blocked");
    assert.equal(e.message, "overpass HTTP 406", "the message names the failure the reason is about");
    assert.ok(e.retryAt > start, "both endpoints are held, so the error says until when");
  }
  { // the same sequence under a street download ends in the blocked-for-today text, with no "no answer" wording
    reset();
    global.fetch = routed({ [M]: status(406), [C]: silent });
    const streets = new StreetIndex({ newFrac: () => 1 });
    const e = await played(streets.ensureRects([{ s: 51, w: 13.7, n: 51.01, e: 13.71 }], "run").then(() => assert.fail("expected a rejection"), (x) => x));
    assert.deepEqual([e.reason, e.done, typeof e.retryAt], ["blocked", 0, "number"]);
    const text = StreetMessages.describe(StreetIndex.downloadFacts(e), t);
    assert.equal(text, "The street server has blocked this network for today: it caps each network's daily use. Try another network, or try again tomorrow.");
    assert.ok(!/no answer|15 s/.test(text + e.message) && !/406/.test(text), text + " / " + e.message);
  }
  { // within the hour main is held and only coffee's silence is fresh: still main's 406, blocked, with a retry time
    reset();
    global.fetch = routed({ [M]: status(406), [C]: silent });
    await rejection(played(Overpass.post("data=x")));
    assert.ok(t - start < 3_600_000 && t - start > 30_000, "main still held, coffee's 30 s over");
    calls = [];
    const e = await rejection(played(Overpass.post("data=x")));
    assert.deepEqual(calls, [C], "main is not asked again");
    assert.equal(e.reason, "blocked");
    assert.equal(e.message, "overpass HTTP 406");
    assert.equal(e.retryAt, start + 3_600_000, "the block's hour, not coffee's fresh 30 s");
    calls = [];
    const streets = new StreetIndex({ newFrac: () => 1 });
    const d = await played(streets.ensureRects([{ s: 51, w: 13.7, n: 51.01, e: 13.71 }], "run").then(() => assert.fail("expected a rejection"), (x) => x));
    assert.deepEqual([d.reason, typeof d.retryAt], ["blocked", "number"]);
    const text = StreetMessages.describe(StreetIndex.downloadFacts(d), t);
    assert.equal(text, "The street server has blocked this network for today: it caps each network's daily use. Try another network, or try again tomorrow.");
    assert.ok(!/no answer|15 s/.test(text + d.message), text + " / " + d.message);
  }
  { // a held endpoint's error carries no retry time left over from an earlier post
    reset();
    global.fetch = routed({ [M]: status(406), [C]: status(429) });
    const first = await rejection(Overpass.post("data=x"));
    assert.equal(typeof first.retryAt, "number");
    t = start + 40_000; global.fetch = routed({ [M]: status(406), [C]: status(500) });
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.reason, "blocked");
    assert.equal(e.retryAt, undefined, "coffee answered and is not held: no retry time");
  }
  { // a remapped offline and the browser's own offline each throw an error of their own reason's
    reset();
    global.fetch = routed({ [M]: unreachable, [C]: status(500) });
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.reason, "server");
    reset();
    global.fetch = routed({ [M]: status(500), [C]: status(500) });
    Object.defineProperty(global.navigator, "onLine", { value: false, configurable: true });
    try {
      const o = await rejection(Overpass.post("data=x"));
      assert.equal(o.reason, "offline");
      assert.ok(!/HTTP 500/.test(o.message), "not a server's error: " + o.message);
    } finally { delete global.navigator.onLine; }
  }
  finished = true;
  console.log("overpass-endpoints.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
