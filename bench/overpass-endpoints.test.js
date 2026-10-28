// Overpass.post: endpoint order (NextGIS first by default, only with a key, offered by main.js once
// the key is set), fallback, at most 4 posts open on NextGIS and 2 on overpass-api.de, the 90 s
// first-byte and 120 s body guards; holds after a 429 (30 s) and a 406 (an hour), each longer with
// Retry-After, a failed fetch and a stall (30 s, ten minutes from the third stall in a row); no hold
// after a 500 or a non-JSON 200; the rejection's reason; a hold reaches posts waiting for a slot,
// stalls of requests open together count once, and a hold is never shortened by one of them.
// Fake fetch, fake clock, fake timers: nothing here waits on real time.
//   node bench/overpass-endpoints.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
require("../app/src/streetMessages.js");
const { Overpass, StreetIndex, StreetMessages } = global;
// a made-up key that holds a character the URL must escape; NextGIS exists only with one
const KEY = "test-key/0";
const N = "https://overpass.nextgis.com/" + encodeURIComponent(KEY) + "/api/interpreter", M = Overpass.ENDPOINTS.main;
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
// key: the page's NextGIS key; null means none, and the default is KEY
// order: most tests are about fallback and holds, written with overpass-api.de asked first; null
// keeps the default order, for the tests about it
function reset({ key = KEY, order = ["main", "nextgis"] } = {}) {
  Overpass._reset();
  if (order) Overpass.setOrder(order);
  if (key === null) delete global.crossfogNextgisKey; else global.crossfogNextgisKey = key;
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
// a post whose stalls are played out on the clock (each endpoint gets at most 120 s, so four minutes
// covers both endpoints in either order); the caller's handler is attached only after that, so the
// rejection is marked handled up front
async function played(p) { p.catch(() => {}); await settle(); await advance(240_000); return p; }
const rejection = (p) => p.then(() => assert.fail("expected a rejection"), (e) => {
  assert.ok(REASONS.includes(e.reason), "the reason is one of five words, got " + JSON.stringify(e.reason));
  return e;
});
// A post() that never settles leaves nothing scheduled, and Node would exit 0 without a verdict.
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) { console.error("overpass-endpoints.test.js did not finish"); process.exitCode = 1; }
});

const realFetch = global.fetch;

(async () => {
  { // 1. default order with a key: NextGIS first
    reset({ order: null });
    assert.deepEqual(await Overpass.post("data=x"), { from: N });
    assert.deepEqual(calls, [N]);
  }
  { // 2-4. a 429 falls through to NextGIS, holds main for 30 s (not the hour a 406 earns), then main is tried again
    reset();
    replies[M] = [{ status: 429 }];
    assert.deepEqual(await Overpass.post("data=x"), { from: N });
    assert.deepEqual(calls, [M, N]);
    calls = []; t = start + 10_000;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [N], "main still on hold 10 s later");
    calls = []; t = start + 30_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M], "main usable again after 30 s");
  }
  { // 5. a 406 is the day's block: the endpoint is held an hour and the rejection says blocked
    reset();
    replies[M] = [{ status: 406 }]; replies[N] = [{ status: 500 }];
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.reason, "blocked");
    assert.equal(e.retryAt, undefined, "a 500 puts no hold on NextGIS");
    calls = []; t = start + 3_599_999;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [N], "main still blocked just under an hour later");
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
    assert.deepEqual(calls, [N], "still within Retry-After");
    calls = []; t = start + 120_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 7. every endpoint rate-limited: reject with retryAt and busy, and send nothing until then
    reset();
    replies[M] = [{ status: 429 }];
    replies[N] = [{ status: 429 }];
    const e1 = await rejection(Overpass.post("data=x"));
    assert.equal(e1.retryAt, start + 30_000);
    assert.equal(e1.reason, "busy");
    assert.deepEqual(calls, [M, N]);
    t = start + 5_000;
    const e2 = await rejection(Overpass.post("data=x"));
    assert.equal(e2.retryAt, start + 30_000);
    assert.equal(e2.reason, "busy", "the holds remember why");
    assert.deepEqual(calls, [M, N], "no request while both are blocked");
  }
  { // 8. a 500 moves on at once and does not block the endpoint
    reset();
    replies[M] = [{ status: 500 }];
    assert.deepEqual(await Overpass.post("data=x"), { from: N });
    calls = [];
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 8b. every endpoint failing without a block rejects with no retryAt; a 504 is the server being busy
    reset();
    replies[M] = [{ status: 500 }];
    replies[N] = [{ status: 504 }];
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.retryAt, undefined);
    assert.equal(e.reason, "busy");
    assert.match(e.message, /504/);
  }
  { // 9. the order is a setting
    reset();
    Overpass.setOrder(["nextgis", "main"]);
    await Overpass.post("data=x");
    assert.deepEqual(calls, [N]);
  }
  { // 10. an order naming no known endpoint reads as the default: NextGIS first
    reset();
    Overpass.setOrder(["nope"]);
    await Overpass.post("data=x");
    assert.deepEqual(calls, [N]);
  }
  // a fetch that answers the URLs in `table` itself and keeps every other request open until the
  // test lets it go, counting what is open per URL
  function heldFetch(table = {}) {
    const open = {}, most = {}, pending = [];
    global.fetch = (url, opts) => {
      calls.push(url);
      assert.ok(opts.signal, "every request carries an abort signal");
      if (table[url]) return table[url](url, opts);
      open[url] = (open[url] || 0) + 1; most[url] = Math.max(most[url] || 0, open[url]);
      return new Promise((resolve) => pending.push({ url, answer: (r) => { open[url]--; resolve(r || { ok: true, status: 200, headers: headers(), json: async () => ({ from: url }) }); } }));
    };
    return { open, most, pending };
  }
  { // 11. NextGIS takes 4 posts at once and overpass-api.de 2; a further post waits for a free slot
    reset({ order: null });
    assert.equal(Overpass.cap(), 4, "the first endpoint's cap: NextGIS");
    const f = heldFetch();
    const posts = [1, 2, 3, 4, 5, 6].map((i) => Overpass.post("data=" + i));
    await settle();
    assert.equal(f.open[N], 4, "four open on NextGIS");
    assert.equal(calls.length, 4, "the fifth and sixth wait");
    f.pending.shift().answer();
    await settle();
    assert.equal(calls.length, 5, "a slot freed: the fifth goes");
    while (f.pending.length) { f.pending.shift().answer(); await settle(); }
    await Promise.all(posts);
    assert.equal(f.most[N], 4);
    assert.equal(calls.length, 6);
    reset({ key: null, order: null });
    assert.equal(Overpass.cap(), 2, "no key: overpass-api.de alone, cap 2");
    const g = heldFetch();
    const three = [1, 2, 3].map((i) => Overpass.post("data=" + i));
    await settle();
    assert.equal(g.open[M], 2);
    assert.equal(calls.length, 2, "the third waits for one of overpass-api.de's two slots");
    while (g.pending.length) { g.pending.shift().answer(); await settle(); }
    await Promise.all(three);
    assert.equal(g.most[M], 2);
    reset({ order: ["main", "nextgis"] });
    assert.equal(Overpass.cap(), 2, "overpass-api.de first: its cap");
  }
  { // 11b. posts falling back from NextGIS take overpass-api.de's slots: never more than 2 open there
    reset({ order: null });
    const f = heldFetch({ [N]: status(500) });
    const posts = [1, 2, 3, 4, 5, 6].map((i) => Overpass.post("data=" + i));
    await settle();
    assert.equal(f.open[M], 2, "two fell back and are open on overpass-api.de");
    assert.equal(calls.filter((u) => u === M).length, 2, "the other fallbacks wait for a slot there");
    while (f.pending.length) { f.pending.shift().answer(); await settle(); }
    const got = await Promise.all(posts);
    assert.deepEqual(got, posts.map(() => ({ from: M })));
    assert.equal(f.most[M], 2);
    assert.equal(calls.filter((u) => u === N).length, 6);
  }
  { // 11c. a hold one request earns reaches the posts already waiting for a slot: they send nothing there
    reset({ key: null, order: null });
    const f = heldFetch();
    const posts = [1, 2, 3, 4].map((i) => Overpass.post("data=" + i));
    const failed = Promise.all(posts.map((p, i) => (i === 1 ? null : rejection(p))));
    await settle();
    assert.equal(calls.length, 2);
    f.pending.shift().answer({ ok: false, status: 429, headers: headers(), json: async () => null });
    await settle();
    assert.equal(calls.length, 2, "overpass-api.de is held: the waiting posts do not go out");
    const [first, , third, fourth] = await failed;
    for (const e of [first, third, fourth]) { assert.equal(e.reason, "busy"); assert.equal(e.retryAt, start + 30_000); }
    f.pending.shift().answer();
    assert.deepEqual(await posts[1], { from: M }, "the request already open carries on");
    // with a key, the waiting posts fall back to NextGIS instead
    reset({ order: ["main", "nextgis"] });
    const g = heldFetch({ [N]: answer });
    const more = [1, 2, 3].map((i) => Overpass.post("data=" + i));
    await settle();
    assert.deepEqual(calls, [M, M]);
    g.pending.shift().answer({ ok: false, status: 429, headers: headers(), json: async () => null });
    await settle();
    assert.deepEqual(calls, [M, M, N, N], "the 429's own post and the waiting one go to NextGIS, not overpass-api.de");
    g.pending.shift().answer();
    assert.deepEqual(await Promise.all(more), [{ from: N }, { from: M }, { from: N }]);
  }
  { // the posts a hold skipped gave their slots back: once the hold is over both overpass-api.de slots are free again
    reset({ key: null, order: null });
    const f = heldFetch();
    const posts = [1, 2, 3, 4].map((i) => Overpass.post("data=" + i));
    const failed = Promise.all(posts.map((p, i) => (i === 1 ? null : rejection(p))));
    await settle();
    f.pending.shift().answer({ ok: false, status: 429, headers: headers(), json: async () => null });
    await settle();
    await failed;
    f.pending.shift().answer();
    await posts[1];
    calls = []; t += 30_001;
    const again = [1, 2, 3].map((i) => Overpass.post("data=" + i));
    await settle();
    assert.equal(calls.length, 2, "two slots, both free, not a leaked one fewer");
    f.pending.shift().answer(); f.pending.shift().answer();
    await settle();
    f.pending.shift().answer();
    assert.equal((await Promise.all(again)).length, 3);
  }
  { // NextGIS fails with a 500 and the run turns stale during that very fetch: overpass-api.de is not asked
    reset({ order: null });
    let stale = false;
    global.fetch = routed({ [N]: () => { stale = true; return status(500)(); }, [M]: answer });
    const e = await Overpass.post("data=1", { stale: () => stale }).then(() => assert.fail("expected a rejection"), (x) => x);
    assert.equal(e.reason, "superseded");
    assert.deepEqual(calls, [N], "the fallback is not sent for a replaced run");
  }
  { // 11d. requests open together that stall together are one stall, not three in a row: a 30 s hold
    reset({ order: null });
    global.fetch = routed({ [N]: silent, [M]: answer });
    const posts = [1, 2, 3].map((i) => Overpass.post("data=" + i));
    await settle(); await advance(90_000);
    assert.deepEqual(await Promise.all(posts), [{ from: M }, { from: M }, { from: M }]);
    calls = []; t += 30_001; global.fetch = routed({ [N]: answer, [M]: answer });
    await Overpass.post("data=4");
    assert.deepEqual(calls, [N], "three stalls at once hold 30 s, as one would");
    // a hold earned meanwhile is never cut short by a request that was already open: a 406's hour
    // outlasts the stall of the request beside it
    reset({ key: null, order: null });
    let n = 0;
    global.fetch = (url, opts) => { calls.push(url); return n++ ? silent(url, opts) : status(406)(); };
    const pair = [1, 2].map((i) => Overpass.post("data=" + i));
    const both = Promise.all(pair.map(rejection));
    await settle();
    assert.equal(calls.length, 2, "both open before the 406 lands");
    await advance(90_000);
    const [blocked, stalled] = await both;
    assert.equal(blocked.reason, "blocked");
    assert.equal(stalled.reason, "blocked", "the stall beside it reports the hour's block, not its own 30 s");
    calls = []; t += 60_000;
    await rejection(Overpass.post("data=3"));
    assert.deepEqual(calls, [], "still held for the 406's hour");
  }
  { // 12. an endpoint that sends no byte is abandoned at 90 s on the clock, the next one is asked in
    //     the same post, and the silent one is held exactly 30 s from the moment it was abandoned
    reset();
    const table = { [M]: silent, [N]: answer };
    global.fetch = routed(table);
    const p = Overpass.post("data=x");
    await settle(); await advance(89_999);
    assert.deepEqual(calls, [M], "still waiting just under 90 s");
    await advance(1);
    assert.deepEqual(calls, [M, N], "abandoned at 90 s; NextGIS asked in the same post");
    assert.deepEqual(await p, { from: N });
    assert.equal(t, start + 90_000);
    calls = []; t = start + 90_000 + 29_999;
    assert.deepEqual(await Overpass.post("data=y"), { from: N }, "the queue is not stuck");
    assert.deepEqual(calls, [N], "the silent endpoint is on hold");
    calls = []; t = start + 90_000 + 30_001; table[M] = answer;
    await Overpass.post("data=z");
    assert.deepEqual(calls, [M], "a single stall holds 30 s, no longer");
  }
  // a post that stalls on main and completes on NextGIS, played out on the clock
  const stallOnce = async () => {
    const p = Overpass.post("data=x");
    await settle(); await advance(90_000);
    assert.deepEqual(await p, { from: N });
  };
  { // 12b. the third stall in a row holds the endpoint ten minutes, and so does every one after it
    reset();
    const table = { [M]: silent, [N]: answer };
    global.fetch = routed(table);
    await stallOnce();
    t += 30_001; await stallOnce();
    calls = []; t += 29_999; await Overpass.post("data=x");
    assert.deepEqual(calls, [N], "the second stall still holds only 30 s");
    t += 2; await stallOnce();
    const third = t;
    calls = []; t = third + 599_999; await Overpass.post("data=x");
    assert.deepEqual(calls, [N], "held ten minutes after the third stall in a row");
    t = third + 600_001; await stallOnce();
    const fourth = t;
    calls = []; t = fourth + 599_999; await Overpass.post("data=x");
    assert.deepEqual(calls, [N], "the fourth stall in a row holds ten minutes too");
    calls = []; t = fourth + 600_001; table[M] = answer; await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 12c. any answer that ends, even a 500, resets the count: stall, stall, 500, stall holds 30 s
    reset();
    const table = { [M]: silent, [N]: answer };
    global.fetch = routed(table);
    await stallOnce();
    t += 30_001; await stallOnce();
    t += 30_001; table[M] = status(500);
    assert.deepEqual(await Overpass.post("data=x"), { from: N });
    table[M] = silent; await stallOnce();
    calls = []; t += 30_001; table[M] = answer; await Overpass.post("data=x");
    assert.deepEqual(calls, [M], "the stall after the status was the first of a new run");
  }
  { // 13. a failure the page cannot read (a TypeError, which is also how a 429 without CORS headers
    //     arrives) holds that endpoint 30 s and does not count as a stall
    reset();
    const table = { [M]: unreachable, [N]: answer };
    global.fetch = routed(table);
    assert.deepEqual(await Overpass.post("data=x"), { from: N });
    calls = []; t = start + 29_999;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [N]);
    calls = []; t = start + 30_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M, N]);
    table[M] = silent; t += 30_001; await stallOnce();
    t += 30_001; await stallOnce();
    calls = []; t += 30_001; table[M] = answer; await Overpass.post("data=x");
    assert.deepEqual(calls, [M], "two stalls after a failed fetch: still a 30 s hold");
  }
  { // 14. every endpoint unreachable: reject with the last fetch error, offline and retryAt;
    //     nothing is sent before then
    reset();
    global.fetch = routed({ [M]: unreachable, [N]: unreachable });
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.retryAt, start + 30_000);
    assert.equal(e.reason, "offline");
    assert.match(e.message, /Failed to fetch/);
    t = start + 1_000;
    const e2 = await rejection(Overpass.post("data=x"));
    assert.equal(e2.reason, "offline", "the holds remember why");
    assert.deepEqual(calls, [M, N]);
  }
  // 15. a 200 whose body is not JSON (a captive portal, a proxy's error page) moves on to the next
  //     endpoint at once and, like a 500, puts no hold on the first; Chromium and Node reject with
  //     a SyntaxError, WebKit with a DOMException named SyntaxError
  for (const bad of [new SyntaxError("Unexpected token '<'"), new DOMException("The string did not match the expected pattern.", "SyntaxError")]) {
    reset();
    global.fetch = routed({ [M]: () => Promise.resolve({ ok: true, status: 200, headers: headers(), json: async () => { throw bad; } }), [N]: answer });
    assert.deepEqual(await Overpass.post("data=x"), { from: N });
    calls = [];
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M, N], "main is not on hold after a " + bad.constructor.name);
  }
  // 15b. a 200 whose JSON is not an object (null, a string, a number: a proxy's remark that happens to
  //      parse) is no answer either: it moves on and holds nothing, like one that is not JSON
  for (const body of [null, "busy", 3]) {
    reset();
    global.fetch = routed({ [M]: () => Promise.resolve({ ok: true, status: 200, headers: headers(), json: async () => body }), [N]: answer });
    assert.deepEqual(await Overpass.post("data=x"), { from: N }, JSON.stringify(body));
    calls = [];
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M, N], "main is not on hold after a body of " + JSON.stringify(body));
    reset();
    global.fetch = routed({ [M]: () => Promise.resolve({ ok: true, status: 200, headers: headers(), json: async () => body }), [N]: status(500) });
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.reason, "server", "every endpoint answered something that is no answer");
  }
  { // 15c. the parser's SyntaxError quotes the body; none of that text reaches the error a caller reads
    reset({ key: null });
    global.fetch = routed({ [M]: () => Promise.resolve({ ok: true, status: 200, headers: headers(), json: async () => { throw new SyntaxError("Unexpected token '<', \"<html>PORTAL-TEXT\" is not valid JSON"); } }) });
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.reason, "server");
    assert.ok(!/PORTAL|html/.test(e.message + e.cause.message), e.message);
  }
  { // 15d. every post throws its own error: a held endpoint's stored error is the cause, so a second post
    //      setting its reason and retryAt cannot change what the first one's caller reads later
    reset({ key: null });
    global.fetch = routed({ [M]: status(429) });
    const first = await rejection(Overpass.post("data=x"));
    const retryAt = first.retryAt;
    t += 10_000;
    const second = await rejection(Overpass.post("data=x"));
    assert.notEqual(first, second);
    assert.equal(second.cause, first.cause, "both carry the stored error");
    assert.notEqual(first.cause, first);
    assert.equal(second.retryAt, retryAt, "one hold, one end");
    second.retryAt = 5;
    assert.equal(first.retryAt, retryAt, "the first caller's retry time is its own");
    assert.equal(first.message, "overpass HTTP 429");
  }
  { // 16. a body that stops after the headers is abandoned 120 s after the request began: the 90 s
    //     first-byte guard ends when the headers arrive, and the body then runs to the 120 s limit
    //     from the request start; the endpoint is held 30 s
    reset();
    const table = { [M]: headersOnly, [N]: answer };
    global.fetch = routed(table);
    const p = Overpass.post("data=x");
    await settle(); await advance(119_999);
    assert.deepEqual(calls, [M], "the body has until 120 s");
    await advance(1);
    assert.deepEqual(calls, [M, N]);
    assert.deepEqual(await p, { from: N });
    calls = []; t += 29_999; await Overpass.post("data=y");
    assert.deepEqual(calls, [N], "the stalled endpoint is on hold");
    calls = []; t += 2; table[M] = answer; await Overpass.post("data=y");
    assert.deepEqual(calls, [M]);
  }
  { // 16b. a body stall's 200 does not end the answer, so it does not reset the count: the third
    //     body stall in a row holds the endpoint ten minutes
    reset();
    const table = { [M]: headersOnly, [N]: answer };
    global.fetch = routed(table);
    const bodyStall = async () => {
      const p = Overpass.post("data=x");
      await settle(); await advance(120_000);
      assert.deepEqual(await p, { from: N });
    };
    await bodyStall();
    t += 30_001; await bodyStall();
    t += 30_001; await bodyStall();
    const third = t;
    calls = []; t = third + 599_999; await Overpass.post("data=x");
    assert.deepEqual(calls, [N], "held ten minutes after the third body stall in a row");
    calls = []; t = third + 600_001; table[M] = answer; await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  { // 16c. headers that arrive at 10 s leave the body 110 s: abandoned at 120 s total
    reset();
    let release;
    const late = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
      release = () => resolve({ ok: true, status: 200, headers: headers(), json: () => silent(url, opts) });
    });
    global.fetch = routed({ [M]: late, [N]: answer });
    const p = Overpass.post("data=x");
    await settle(); await advance(10_000); release(); await settle();
    await advance(109_999);
    assert.deepEqual(calls, [M]);
    await advance(1);
    assert.deepEqual(calls, [M, N]);
    assert.deepEqual(await p, { from: N });
  }
  { // 17. the reason is the most actionable of what the endpoints said:
    //     blocked over busy over stalled over offline over server
    const cases = [
      [{ [M]: status(406), [N]: status(429) }, "blocked"],
      [{ [M]: status(429), [N]: status(406) }, "blocked"],
      [{ [M]: status(429), [N]: silent }, "busy"],
      [{ [M]: silent, [N]: status(502) }, "busy"],
      [{ [M]: status(502), [N]: status(500) }, "busy"],
      [{ [M]: silent, [N]: unreachable }, "stalled"],
      [{ [M]: headersOnly, [N]: status(500) }, "stalled"],
      [{ [M]: unreachable, [N]: unreachable }, "offline"],
      [{ [M]: unreachable, [N]: status(500) }, "server"], // a status was seen: the network is up
      [{ [M]: status(500), [N]: notJson }, "server"],
      [{ [M]: status(400), [N]: status(500) }, "server"]
    ];
    for (const [table, want] of cases) {
      reset();
      global.fetch = routed(table);
      const e = await rejection(played(Overpass.post("data=x")));
      assert.equal(e.reason, want, Object.values(table).map((f) => f.name || "status").join(" + "));
    }
  }
  { // 17b. the browser saying it is offline outranks a server error, not a block
    for (const [table, want] of [[{ [M]: status(500), [N]: status(500) }, "offline"], [{ [M]: status(406), [N]: status(500) }, "blocked"]]) {
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
    replies[M] = [{ status: 406 }]; replies[N] = [{ status: 429 }];
    await rejection(Overpass.post("data=x"));
    calls = []; t = start + 10_000;
    const e = await rejection(Overpass.post("data=x"));
    assert.deepEqual(calls, []);
    assert.equal(e.reason, "blocked");
    assert.equal(e.retryAt, start + 3_600_000, "blocked: the retry time is the block's hour, not NextGIS's 30 s");
    calls = []; t = start + 30_001;
    await Overpass.post("data=x");
    assert.deepEqual(calls, [N], "NextGIS itself is still asked again after its 30 s");
  }
  { // a 406 on main, then NextGIS silent: blocked wins, and the error is main's 406, not NextGIS's silence
    reset();
    global.fetch = routed({ [M]: status(406), [N]: silent });
    const e = await rejection(played(Overpass.post("data=x")));
    assert.deepEqual(calls, [M, N]);
    assert.equal(e.reason, "blocked");
    assert.equal(e.message, "overpass HTTP 406", "the message names the failure the reason is about");
    assert.ok(e.retryAt > start, "both endpoints are held, so the error says until when");
  }
  { // the same sequence under a street download ends in the blocked-for-today text, with no "no answer" wording
    reset();
    global.fetch = routed({ [M]: status(406), [N]: silent });
    const streets = new StreetIndex({ newFrac: () => 1 });
    const e = await played(streets.ensureRects([{ s: 51, w: 13.7, n: 51.01, e: 13.71 }], "run").then(() => assert.fail("expected a rejection"), (x) => x));
    assert.deepEqual([e.reason, e.done, typeof e.retryAt], ["blocked", 0, "number"]);
    const text = StreetMessages.describe(StreetIndex.downloadFacts(e), t);
    assert.equal(text, "The street server has blocked this network for today: it caps each network's daily use. Try another network, or try again tomorrow.");
    assert.ok(!/no answer|90 s/.test(text + e.message) && !/406/.test(text), text + " / " + e.message);
  }
  { // within the hour main is held and only NextGIS's silence is fresh: the post's own stall outranks the
    // held block, with NextGIS's error and, every endpoint now held, the first hold's end
    reset();
    global.fetch = routed({ [M]: status(406), [N]: silent });
    await rejection(played(Overpass.post("data=x")));
    assert.ok(t - start < 3_600_000 && t - start > 30_000, "main still held, NextGIS's 30 s over");
    calls = [];
    const sent = t;
    const e = await rejection(played(Overpass.post("data=x")));
    assert.deepEqual(calls, [N], "main is not asked again");
    assert.equal(e.reason, "stalled");
    assert.ok(!/406/.test(e.message), "NextGIS's own failure, not main's 406: " + e.message);
    assert.equal(e.retryAt, sent + 90_000 + 30_000, "NextGIS's 30 s stall hold ends first");
  }
  { // a hold carried over from an earlier post outranks only when this post had nothing better:
    // overpass-api.de held for its 406 and NextGIS answering 502 now is busy, with NextGIS's error and no
    // retry time; a 429 holds NextGIS too and stays busy, with the first hold's end; with every endpoint
    // held before the post, the held block wins as before; a 406 in this post is blocked
    reset({ order: null });
    global.fetch = routed({ [N]: status(500), [M]: status(406) });
    assert.equal((await rejection(Overpass.post("data=x"))).reason, "blocked", "this post's own 406");
    calls = []; t = start + 60_000;
    global.fetch = routed({ [N]: status(502), [M]: answer });
    const busy = await rejection(Overpass.post("data=x"));
    assert.deepEqual(calls, [N], "main is held for its hour");
    assert.deepEqual([busy.reason, busy.message, busy.retryAt], ["busy", "overpass HTTP 502", undefined]);
    global.fetch = routed({ [N]: status(429), [M]: answer });
    const limited = await rejection(Overpass.post("data=x"));
    assert.deepEqual([limited.reason, limited.message, limited.retryAt], ["busy", "overpass HTTP 429", t + 30_000]);
    calls = [];
    const held = await rejection(Overpass.post("data=x"));
    assert.deepEqual([calls, held.reason, held.message, held.retryAt], [[], "blocked", "overpass HTTP 406", start + 3_600_000]);
    t += 30_001; global.fetch = routed({ [N]: status(406), [M]: answer });
    assert.equal((await rejection(Overpass.post("data=x"))).reason, "blocked", "NextGIS's own 406");
    // the browser's offline joins the post's own failures: it outranks a fresh 500, not a held block
    reset();
    global.fetch = routed({ [M]: status(406), [N]: status(500) });
    await rejection(Overpass.post("data=x"));
    t += 30_001;
    Object.defineProperty(global.navigator, "onLine", { value: false, configurable: true });
    try {
      assert.equal((await rejection(Overpass.post("data=x"))).reason, "offline");
    } finally { delete global.navigator.onLine; }
  }
  { // a fresh 500 beside a held 406 is the post's own failure: server, with no retry time left over from
    // the earlier post that held both endpoints
    reset();
    global.fetch = routed({ [M]: status(406), [N]: status(429) });
    const first = await rejection(Overpass.post("data=x"));
    assert.equal(typeof first.retryAt, "number");
    t = start + 40_000; global.fetch = routed({ [M]: status(406), [N]: status(500) });
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.reason, "server");
    assert.equal(e.retryAt, undefined, "NextGIS answered and is not held: no retry time");
  }
  { // a post whose caller went stale while it waited for a slot is not sent: the slot passes to the next
    // post and the stale one rejects superseded; one stale before it asks anything sends nothing
    reset({ key: null, order: null });
    const f = heldFetch();
    let stale = false;
    const open = [1, 2].map((i) => Overpass.post("data=" + i));
    const waiting = Overpass.post("data=3", { stale: () => stale });
    waiting.catch(() => {});
    const after = Overpass.post("data=4");
    await settle();
    assert.equal(calls.length, 2, "two open, two waiting for a slot");
    stale = true;
    f.pending.shift().answer();
    await settle();
    const e = await waiting.then(() => assert.fail("expected a rejection"), (x) => x);
    assert.deepEqual([e.reason, e.retryAt], ["superseded", undefined]);
    assert.equal(calls.length, 3, "the stale post sent nothing; its slot went to the next post");
    while (f.pending.length) { f.pending.shift().answer(); await settle(); }
    assert.deepEqual(await Promise.all([...open, after]), [{ from: M }, { from: M }, { from: M }]);
    assert.equal(f.most[M], 2);
    calls = [];
    const already = await Overpass.post("data=5", { stale: () => true }).then(() => assert.fail("expected a rejection"), (x) => x);
    assert.deepEqual([already.reason, calls], ["superseded", []]);
  }
  { // a post waiting for a slot whose caller goes stale drops out within a second, while both slots are
    // still busy: its run need not wait for a slot to free to hear it; the next post keeps its place
    reset({ key: null, order: null });
    const f = heldFetch();
    let stale = false, e = null;
    const open = [1, 2].map((i) => Overpass.post("data=" + i));
    Overpass.post("data=3", { stale: () => stale }).catch((x) => { e = x; });
    const after = Overpass.post("data=4");
    await settle();
    await advance(5000);
    assert.equal(e, null, "not stale: it waits on");
    stale = true;
    await advance(1000);
    assert.deepEqual([e && e.reason, calls.length], ["superseded", 2], "dropped out with nothing sent");
    f.pending.shift().answer();
    await settle();
    assert.equal(calls.length, 3, "the freed slot went to the next post");
    while (f.pending.length) { f.pending.shift().answer(); await settle(); }
    await Promise.all([...open, after]);
    stale = false;
    let bugged = null;
    const bug = new Error("stale broke");
    const more = [5, 6].map((i) => Overpass.post("data=" + i));
    Overpass.post("data=7", { stale: () => { if (stale) throw bug; return false; } }).catch((x) => { bugged = x; });
    await settle();
    stale = true;
    await advance(1000);
    assert.equal(bugged, bug, "a stale() that throws while waiting rejects as itself");
    while (f.pending.length) { f.pending.shift().answer(); await settle(); }
    await Promise.all(more);
    assert.equal(f.most[M], 2);
  }
  { // a stale() that throws once the post holds its slot gives the slot back: both slots
    // still take the next two posts at once
    reset({ key: null, order: null });
    const f = heldFetch();
    let asked = 0;
    const bug = new Error("stale broke");
    const e = await Overpass.post("data=1", { stale: () => { if (asked++) throw bug; return false; } }).then(() => assert.fail("expected a rejection"), (x) => x);
    assert.equal(e, bug, "the throw passes through as itself");
    const next = [2, 3].map((i) => Overpass.post("data=" + i));
    await settle();
    assert.deepEqual(calls, [M, M], "both of overpass-api.de's slots are free");
    while (f.pending.length) { f.pending.shift().answer(); await settle(); }
    await Promise.all(next);
  }
  { // a remapped offline and the browser's own offline each throw an error of their own reason's
    reset();
    global.fetch = routed({ [M]: unreachable, [N]: status(500) });
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.reason, "server");
    reset();
    global.fetch = routed({ [M]: status(500), [N]: status(500) });
    Object.defineProperty(global.navigator, "onLine", { value: false, configurable: true });
    try {
      const o = await rejection(Overpass.post("data=x"));
      assert.equal(o.reason, "offline");
      assert.ok(!/HTTP 500/.test(o.message), "not a server's error: " + o.message);
    } finally { delete global.navigator.onLine; }
  }
  { // with no key, there is no NextGIS endpoint: overpass-api.de alone, whatever the order says
    reset({ key: null, order: null });
    assert.equal(Overpass.has("nextgis"), false);
    assert.equal(Overpass.has("main"), true);
    replies[M] = [{ status: 500 }];
    assert.equal((await rejection(Overpass.post("data=x"))).reason, "server");
    assert.deepEqual(calls, [M]);
    calls = []; Overpass.setOrder(["nextgis", "main"]);
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
    for (const key of ["", 42]) {
      reset({ key });
      assert.equal(Overpass.has("nextgis"), false, "not a key: " + JSON.stringify(key));
    }
  }
  { // with a key the default asks NextGIS first, then overpass-api.de
    reset({ order: null });
    replies[N] = [{ status: 500 }];
    assert.deepEqual(await Overpass.post("data=x"), { from: M });
    assert.deepEqual(calls, [N, M]);
  }
  { // NextGIS comes first once a key is set: the key is read when a post goes out, since the
    // phone app may hand it over after this file ran
    reset({ key: null, order: null });
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
    calls = [];
    global.crossfogNextgisKey = KEY;
    assert.equal(Overpass.has("nextgis"), true);
    assert.deepEqual(await Overpass.post("data=x"), { from: N });
    assert.deepEqual(calls, [N]);
  }
  { // a stored order naming an endpoint that does not exist, or nothing, reads as the default
    for (const stored of [["coffee", "main"], ["coffee"], ["main", "coffee"], ["coffee", "nextgis"], ["nope"], []]) {
      reset();
      Overpass.setOrder(stored);
      replies[N] = [{ status: 500 }];
      await Overpass.post("data=x");
      assert.deepEqual(calls, [N, M], JSON.stringify(stored));
    }
    for (const [stored, want] of [[["nextgis"], [N, M]], [["main"], [M, N]]]) {
      reset();
      Overpass.setOrder(stored);
      replies[want[0]] = [{ status: 500 }];
      await Overpass.post("data=x");
      assert.deepEqual(calls, want, "an order naming one endpoint keeps the other after it");
    }
  }
  { // the key is in the URL alone: no rejection's message carries it, whatever failed
    const tables = [
      { [M]: status(406), [N]: status(429) }, { [M]: silent, [N]: headersOnly },
      { [M]: unreachable, [N]: unreachable }, { [M]: status(500), [N]: notJson }, { [M]: status(502), [N]: silent }
    ];
    for (const table of tables) {
      reset();
      global.fetch = routed(table);
      const e = await rejection(played(Overpass.post("data=x")));
      for (const secret of [KEY, encodeURIComponent(KEY), "nextgis.com"]) assert.ok(!e.message.includes(secret), e.reason);
    }
  }
  { // main.js's endpoint choice, run against a key the phone app hands in after the page loaded:
    // NextGIS is hidden until the key's event, then offered and asked first, whether the user
    // stored that choice, stored nothing (the default) or holds a name that no longer exists
    // ("coffee"), which reads as the default; a stored choice of overpass-api.de stays
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "app", "src", "main.js"), "utf8");
    const from = src.indexOf('  const ORDER_KEY = "f2m_overpassOrder"'), to = src.indexOf("\n", src.indexOf('$("overpass").addEventListener("change"'));
    assert.ok(from >= 0 && to > from,
      "main.js still defines ORDER_KEY and the Street data change listener, so the slice under test exists");
    for (const [stored, firstWithKey] of [["nextgis", N], [null, N], ["coffee", N], ["main", M]]) {
      const els = { overpass: { value: "", addEventListener: (type, fn) => { els.onChange = fn; } }, overpassNextgis: { hidden: false } }, listeners = {};
      const win = { addEventListener: (type, fn) => { listeners[type] = fn; } };
      const removed = [], set = [];
      const storage = {
        getItem: (k) => (k === "f2m_overpassOrder" ? stored : null),
        setItem: (k, v) => set.push([k, v]), removeItem: (k) => removed.push(k)
      };
      reset({ key: null, order: null });
      new Function("$", "Overpass", "localStorage", "window", src.slice(from, to))(
        (id) => els[id], Overpass, storage, win);
      assert.deepEqual(removed, ["f2m_overpass"], "the old setting is dropped on load");
      assert.deepEqual(set, [], "nothing written on load: only an explicit choice is stored");
      assert.equal(els.overpassNextgis.hidden, true, "no key: NextGIS not offered");
      assert.equal(els.overpass.value, "main");
      await Overpass.post("data=x");
      assert.deepEqual(calls, [M], "no key: " + stored);
      calls = [];
      global.crossfogNextgisKey = KEY;
      listeners["crossfog-nextgis-key"]();
      assert.equal(els.overpassNextgis.hidden, false, "the key is in: NextGIS offered");
      assert.equal(els.overpass.value, firstWithKey === N ? "nextgis" : "main", "the choice shown: " + stored);
      await Overpass.post("data=x");
      assert.deepEqual(calls, [firstWithKey], "asked first with the key: " + stored);
      els.onChange({ target: { value: "main" } });
      assert.deepEqual(set, [["f2m_overpassOrder", "main"]], "an explicit choice is stored");
    }
  }
  { // 19. a 401 or 403 from NextGIS (a revoked or mistyped key) holds it an hour and is logged once per
    //     endpoint name with status and name only: never the URL, which holds the key
    for (const code of [401, 403]) {
      reset({ order: null });
      const warned = [], realWarn = console.warn;
      console.warn = (...a) => warned.push(a);
      try {
        global.fetch = routed({ [N]: status(code), [M]: answer });
        assert.deepEqual(await Overpass.post("data=x"), { from: M });
        assert.deepEqual(calls, [N, M]);
        calls = []; t = start + 3_599_000;
        await Overpass.post("data=x");
        assert.deepEqual(calls, [M], code + ": NextGIS not asked again within the hour");
        calls = []; t = start + 3_600_001;
        await Overpass.post("data=x");
        assert.deepEqual(calls, [N, M], code + ": asked again after the hour (rejected again, so on to the next)");
        await Overpass.post("data=x");
        assert.deepEqual(warned, [["[overpass] endpoint answered", "nextgis", code]], "one line per endpoint name, not per request");
        const text = JSON.stringify(warned);
        for (const secret of [KEY, encodeURIComponent(KEY), "nextgis.com", "http"]) assert.ok(!text.includes(secret), "the log holds no URL or key");
        reset({ order: null });
        global.fetch = routed({ [N]: status(code), [M]: status(500) });
        const e = await rejection(Overpass.post("data=x"));
        assert.equal(e.reason, "server");
        assert.equal(e.retryAt, undefined, "overpass-api.de is not held");
      } finally { console.warn = realWarn; }
    }
    // overpass-api.de alone: its 403 is no credential problem, so it is not held
    reset({ key: null });
    global.fetch = routed({ [M]: status(403) });
    await rejection(Overpass.post("data=x"));
    calls = [];
    await rejection(Overpass.post("data=x"));
    assert.deepEqual(calls, [M], "overpass-api.de is asked again at once");
  }
  { // 20. a browser that reports offline wins when no endpoint was asked in this post: every one is
    //     held from an earlier post, so the person is not told the server is slow
    for (const code of [429, 406]) {
      reset({ key: null });
      global.fetch = routed({ [M]: status(code) });
      await rejection(Overpass.post("data=x"));
      Object.defineProperty(global.navigator, "onLine", { value: false, configurable: true });
      try {
        calls = [];
        const e = await rejection(Overpass.post("data=x"));
        assert.deepEqual(calls, [], "held: nothing sent");
        assert.equal(e.reason, "offline");
        assert.ok(e.retryAt > t, "the hold's end is still reported");
      } finally { delete global.navigator.onLine; }
    }
  }
  { // 21. cap() is the cap of the first endpoint that is not held: NextGIS's 4, overpass-api.de's 2 while
    //     NextGIS is held, NextGIS's again when the hold ends or when every endpoint is held
    reset({ order: null });
    assert.equal(Overpass.cap(), 4);
    global.fetch = routed({ [N]: status(429), [M]: answer });
    await Overpass.post("data=x");
    assert.equal(Overpass.cap(), 2);
    t += 30_001;
    assert.equal(Overpass.cap(), 4);
    global.fetch = routed({ [N]: status(429), [M]: status(429) });
    await rejection(Overpass.post("data=x"));
    assert.equal(Overpass.cap(), 4, "everything held: the first endpoint's");
  }
  { // 22. a body cut off by our own abort can make json() reject with a SyntaxError on the cut text: a
    //     stall (30 s hold, ten minutes from the third), not a non-JSON 200 that moves on without a hold
    reset({ key: null });
    const cutOff = (url, opts) => Promise.resolve({
      ok: true, status: 200, headers: headers(),
      json: () => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new SyntaxError("Unexpected end of JSON input"))))
    });
    global.fetch = routed({ [M]: cutOff });
    for (let i = 1; i <= 3; i++) {
      const e = await rejection(played(Overpass.post("data=x")));
      assert.equal(e.reason, "stalled", "stall " + i);
      const hold = e.retryAt - t;
      assert.ok(i < 3 ? hold <= 30_000 : hold > 300_000, "hold after stall " + i + ": " + hold);
      t = e.retryAt + 1;
    }
  }
  { // 23. a 406 with Retry-After: 7200 holds two hours, not one
    reset({ key: null });
    replies[M] = [{ status: 406, headers: { "retry-after": "7200" } }];
    const e = await rejection(Overpass.post("data=x"));
    assert.equal(e.reason, "blocked");
    assert.equal(e.retryAt - start, 7_200_000);
    calls = []; t = start + 3_700_000;
    await rejection(Overpass.post("data=x"));
    assert.deepEqual(calls, [], "still blocked after the default hour");
  }
  { // 24. a failed fetch between two stalls leaves the count alone: only an answer that ends resets it
    reset({ key: null });
    const table = { [M]: silent };
    global.fetch = routed(table);
    await rejection(played(Overpass.post("data=x")));
    t += 30_001; table[M] = unreachable;
    await rejection(Overpass.post("data=x"));
    t += 30_001; table[M] = silent;
    await rejection(played(Overpass.post("data=x")));
    t += 30_001;
    const e = await rejection(played(Overpass.post("data=x")));
    assert.ok(e.retryAt - t > 300_000, "the third stall, though a failed fetch came between: ten minutes");
  }
  { // 25. a 200 whose JSON carries an Overpass remark resolves: the answer is the caller's to read
    //     (StreetIndex words a remark as a server failure), the client holds nothing for it
    reset({ key: null });
    replies[M] = [{ status: 200, body: { remark: "runtime error: Query timed out", elements: [] } }];
    assert.equal((await Overpass.post("data=x")).remark, "runtime error: Query timed out");
    calls = [];
    await Overpass.post("data=x");
    assert.deepEqual(calls, [M]);
  }
  delete global.crossfogNextgisKey;
  global.fetch = realFetch;
  finished = true;
  { // the page has what main.js looks up for the endpoint choice: a renamed id would make main.js throw on load
    const fs = require("fs"), path = require("path");
    const html = fs.readFileSync(path.join(__dirname, "..", "app", "index.html"), "utf8");
    const main = fs.readFileSync(path.join(__dirname, "..", "app", "src", "main.js"), "utf8");
    const used = [...new Set([...main.matchAll(/\$\("(overpass\w*)"\)/g)].map((m) => m[1]))];
    assert.ok(used.includes("overpass") && used.includes("overpassNextgis"));
    for (const id of used) assert.ok(html.includes('id="' + id + '"'), id + " exists in index.html");
    const select = html.match(/<select id="overpass"[\s\S]*?<\/select>/);
    assert.ok(select, "the endpoint <select>");
    assert.deepEqual([...select[0].matchAll(/<option value="(\w+)"/g)].map((m) => m[1]).sort(), ["main", "nextgis"]);
  }
  console.log("overpass-endpoints.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
