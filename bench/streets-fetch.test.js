// StreetIndex.ensureRects: which lists the Overpass query asks for and how the reply is read; fake fetch, no network.
//   node bench/streets-fetch.test.js
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { StreetIndex } = require("./lib/load.js");

const way = (id) => ({ type: "way", id, nodes: [id * 10, id * 10 + 1], geometry: [{ lat: 51, lon: 13.7 }, { lat: 51.001, lon: 13.7 }] });
const ids = (...xs) => xs.map((id) => ({ type: "way", id }));
const count = { type: "count" };
// the seven count markers a complete answer ends with (one per list, empty or not)
const EMPTY = Array(7).fill(count);
let sent = null;
function replyWith(body) {
  global.fetch = async (url, opts) => { sent = decodeURIComponent(opts.body); return { ok: true, status: 200, json: async () => body }; };
}
const rect = [{ s: 51, w: 13.7, n: 51.01, e: 13.71 }];
let nextWay = 100;
// the bboxes a query asks for, as it writes them
const boxesOf = (body) => [...new Set([...decodeURIComponent(body).matchAll(/\(([\d.,]+)\);/g)].map((m) => m[1]))];
// one way in every tile of every bbox
function tileElements(boxes) {
  const elements = [];
  for (const b of boxes) {
    const [s, w, n, e] = b.split(",").map(Number);
    for (const t of StreetIndex.tilesCovering({ s, w, n, e })) {
      const id = nextWay++, tb = StreetIndex.tileBounds(t);
      elements.push({ type: "way", id, nodes: [id * 10, id * 10 + 1], geometry: [{ lat: tb.s + 0.001, lon: tb.w + 0.001 }, { lat: tb.s + 0.002, lon: tb.w + 0.001 }] });
    }
  }
  return elements.concat(EMPTY);
}
// Answers each query with one way in every tile of every bbox it asks for, and records the query's
// bboxes, space-separated; fail(n, bboxes) gives the HTTP status for the n-th query (from 1), nothing
// for a 200.
function tileServer(fail) {
  const asked = [];
  global.fetch = async (url, opts) => {
    const boxes = boxesOf(opts.body);
    asked.push(boxes.join(" "));
    const status = fail && fail(asked.length, asked[asked.length - 1]);
    if (status) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ elements: tileElements(boxes) }) };
  };
  return asked;
}
// Like tileServer, but a request stays open until the test answers it. srv.pending holds the open
// ones in the order sent; srv.reply(i, status) answers the i-th with that status, or with its tiles
// when none, then lets the run react. srv.most counts the most open at once per endpoint ("nextgis",
// "main"); answerAt {endpoint: status} answers that endpoint at once with the status, unrecorded.
function heldServer(answerAt) {
  const srv = { asked: [], pending: [], open: {}, most: {} };
  global.fetch = (url, opts) => {
    const at = url.includes("nextgis") ? "nextgis" : "main", boxes = boxesOf(opts.body);
    if (answerAt && answerAt[at]) return Promise.resolve({ ok: false, status: answerAt[at], json: async () => ({}) });
    srv.asked.push(boxes.join(" "));
    srv.open[at] = (srv.open[at] || 0) + 1;
    srv.most[at] = Math.max(srv.most[at] || 0, srv.open[at]);
    return new Promise((resolve) => srv.pending.push({ boxes, answer: (status) => {
      srv.open[at]--;
      resolve(status ? { ok: false, status, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ elements: tileElements(boxes) }) });
    } }));
  };
  srv.reply = async (i, status) => { srv.pending.splice(i, 1)[0].answer(status); await settle(); };
  return srv;
}
// a run that must settle: fails the test, rather than hanging it, when it does not
const within = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("the run never settled")), 1000))]);
// lets the chains the last answer set off run: five turns cover the store's writes and the next
// sends in these tests
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
// a made-up NextGIS key: with one, NextGIS is asked first and takes four requests at once
const KEY = "test-key";
const withKey = () => { global.crossfogNextgisKey = KEY; };
// 16 tiles in the four 2x2 blocks of 548..551 x 2040..2043; 24 tiles in six blocks out to x 553
const sixteen = [{ s: 51.0, w: 13.7, n: 51.1, e: 13.8 }];
const twelve = [{ s: 51.0, w: 13.7, n: 51.05, e: 13.84 }]; // three blocks
const twentyFour = [{ s: 51.0, w: 13.7, n: 51.1, e: 13.85 }];
// the bbox of tiles x0..x1 by y0..y1, as a query writes it
const span = (x0, y0, x1, y1) => [y0, x0, y1 + 1, x1 + 1].map((v) => (v * StreetIndex.TILE_DEG).toFixed(4)).join(",");
const box = (x, y) => span(x, y, x, y);
const T = (x, y) => ({ x, y });
// a clock the run's waits move: sleep(ms) records ms and moves the clock on at once
function fakeClock() {
  const clock = { t: 0, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; };
  return clock;
}
// two rects, five tiles: the 2x2 block 548..549 x 2040..2041, nearest the centre, then 550:2040
const fiveTiles = [{ s: 51.0, w: 13.7, n: 51.05, e: 13.75 }, { s: 51.0, w: 13.75, n: 51.025, e: 13.775 }];
// A street source on a fake clock: every tile takes stepMs to arrive and is handed over through onTile.
function slowSource(clock, stepMs) {
  const asked = [];
  const fetchStreets = async (tiles, kind, onTile) => {
    const out = new Map();
    for (const t of tiles) {
      asked.push(t.x + ":" + t.y);
      clock.t += stepMs;
      const answer = { ways: [], groups: {} };
      out.set(t.x + ":" + t.y, answer);
      onTile(t, answer);
    }
    return out;
  };
  return { fetchStreets, asked };
}

// A fake for the StreetIndex `every` option ((fn, ms) -> stop), the timer a waiting run checks
// stale() (and, waiting for another run's tile, its deadline) on: fire() runs every check now, live
// counts the checks still set
function ticker() {
  const fns = new Set();
  return { every: (fn) => { fns.add(fn); return () => fns.delete(fn); }, fire: () => [...fns].forEach((fn) => fn()), get live() { return fns.size; } };
}

// Runs one test case with its own fake fetch, a clean Overpass (holds, slots, clock, order) and no NextGIS
// key. Until the body installs a fetch, fetch refuses, so a case that forgets its fake fails instead of
// reaching the network. All of it is put back afterwards, also when the case throws.
async function testCase(body) {
  const real = global.fetch;
  const clean = () => { global.Overpass._reset(); delete global.crossfogNextgisKey; };
  clean();
  global.fetch = async () => { throw new Error("this test case installed no fake fetch"); };
  try { await body(); } finally { global.fetch = real; clean(); }
}

// Every run's reports stay within total and never go back down (concurrent runs included): checked here for
// every ensureRects call in this file, whatever the case does with its own onProgress.
{
  const ensureRects = StreetIndex.prototype.ensureRects;
  StreetIndex.prototype.ensureRects = function (rects, kind, opts) {
    let last = 0;
    const own = opts && opts.onProgress;
    const onProgress = (p) => {
      assert.ok(p.done <= p.total, "done " + p.done + " above total " + p.total);
      assert.ok(p.done >= last, "done went back from " + last + " to " + p.done);
      last = p.done;
      if (own) own(p);
    };
    return ensureRects.call(this, rects, kind, Object.assign({}, opts, { onProgress }));
  };
}

(async () => {
  await testCase(async () => { // a wheeled (bike-kind) fetch asks for the travel classes too, so the road profile is filtered
    // geometry, then bike, road, car, oneWay, reverseWay, bikeBoth, motorway
    replyWith({ elements: [way(1), way(2), count, ...ids(1, 2), count, ...ids(2), count, ...ids(2), count, ...ids(1), count, count, ...ids(2), count, ...ids(1)] });
    const s = new StreetIndex({ newFrac: () => 1 });
    await s.ensureRects(rect, "bike");
    assert.deepEqual([...s.bikeBoth], [2]);
    assert.deepEqual([...s.motorway], [1]);
    assert.deepEqual([...s.classIds.bike], [1, 2]);
    assert.deepEqual([...s.classIds.road], [2]);
    assert.deepEqual([...s.classIds.car], [2]);
    assert.deepEqual([...s.oneWay], [1]);
    assert.deepEqual([...s.classified], [1, 2]);
    assert.ok(sent.indexOf(".bike") < sent.indexOf(".oneWay"), "class lists come before the one-way lists");
  });
  await testCase(async () => { // an Overpass answer that ran out of time or memory is a failed fetch, not an empty area
    replyWith({ elements: [way(1)], remark: "runtime error: Query timed out in \"query\" at line 3 after 61 seconds." });
    const s = new StreetIndex({ newFrac: () => 1 });
    const err = await s.ensureRects(rect, "run").then(() => null, (e) => e);
    assert.ok(!/timed out|runtime error/.test(err.message), "no server text in the message");
    assert.equal(err.reason, "server", "a remark is the server's failure, so the page can word it");
    assert.equal(s.tiles.size, 0, "the area is not recorded as fetched");
  });
  await testCase(async () => { // the box is scanned once; every list is filtered from that result (rescanning per list timed out Overpass)
    replyWith({ elements: EMPTY });
    await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "run");
    assert.equal(sent.split("51.0000,13.7000").length - 1, 2, "one highway clause and one service clause");
    assert.match(sent, /->\.all;/);
  });
  await testCase(async () => { // bikes are kept off bicycle=no
    replyWith({ elements: EMPTY });
    await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "bike");
    assert.match(sent, /\.bike;|->\.bike/);
    const bikeList = sent.slice(sent.indexOf("("), sent.length).split("->.bike")[0];
    assert.match(bikeList.slice(bikeList.lastIndexOf("(")), /\[bicycle!=no\]/);
  });
  await testCase(async () => { // walking and wheels both exclude motorroads; walking also foot=no
    replyWith({ elements: EMPTY });
    await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "run");
    assert.match(sent, /\[motorroad!=yes\]\[foot!=no\]/);
    await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "bike");
    assert.match(sent, /\[motorroad!=yes\]/);
    assert.doesNotMatch(sent, /foot!=no/);
  });
  await testCase(async () => { // a rect inside tiles that are already fetched makes no call
    let calls = 0;
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles) => { calls++; return new Map(tiles.map((t) => [t.x + ":" + t.y, { ways: [], groups: {} }])); } });
    await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.1, e: 13.8 }], "run");
    assert.equal(calls, 1);
    await s.ensureRects([{ s: 51.02, w: 13.72, n: 51.03, e: 13.73 }], "run");
    await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.1, e: 13.8 }], "run");
    assert.equal(calls, 1, "a rect inside fetched tiles, and the same rect again, fetch nothing");
    assert.equal(s.covered(51.09, 13.79), true);
    assert.equal(s.covered(51.11, 13.79), false, "the tile north of the fetch is not covered");
  });
  await testCase(async () => { // a rect over two tiles side by side in one 2x2 block is one query over the box they fill, a highway
    // and a service clause; two tiles side by side in two blocks are a query each
    const bodies = [];
    global.fetch = async (url, opts) => { bodies.push(decodeURIComponent(opts.body)); return { ok: true, status: 200, json: async () => ({ elements: EMPTY }) }; };
    const s = new StreetIndex({ newFrac: () => 1 });
    await s.ensureRects([{ s: 51.01, w: 13.71, n: 51.02, e: 13.73 }], "run");
    assert.equal(bodies.length, 1, "one query for both tiles");
    assert.deepEqual([...bodies[0].matchAll(/\(([\d.,]+)\);/g)].map((m) => m[1]), ["51.0000,13.7000,51.0250,13.7500", "51.0000,13.7000,51.0250,13.7500"]);
    assert.equal(s.covered(51.01, 13.71), true);
    assert.equal(s.covered(51.01, 13.74), true);
    await new StreetIndex({ newFrac: () => 1 }).ensureRects([{ s: 51.01, w: 13.74, n: 51.02, e: 13.76 }], "run");
    assert.equal(bodies.length, 3, "549 and 550 are in two blocks");
  });
  await testCase(async () => { // tiles are the 0.025° grid; an east or north bound on a tile edge does not pull in the next tile, but a rect with no width there still finds its tile
    assert.equal(StreetIndex.TILE_DEG, 0.025);
    assert.deepEqual(StreetIndex.tileOf(13.72, 51.03), { x: 548, y: 2041 });
    assert.equal(StreetIndex.tilesCovering({ s: 51.0, w: 13.7, n: 51.1, e: 13.8 }).length, 16, "a 0.1° square is 4 x 4 tiles");
    assert.deepEqual(StreetIndex.tilesCovering({ s: 51.0, w: 13.7, n: 51.025, e: 13.725 }), [{ x: 548, y: 2040 }]);
    assert.deepEqual(StreetIndex.tilesCovering({ s: 51.03, w: 13.725, n: 51.03, e: 13.725 }), [{ x: 549, y: 2041 }]);
    assert.deepEqual(StreetIndex.tilesCovering({ s: 51.05, w: 13.71, n: 51.05, e: 13.72 }), [{ x: 548, y: 2042 }], "no height on a south edge");
    assert.deepEqual(StreetIndex.tilesCovering({ s: -0.02, w: -0.05, n: -0.01, e: -0.05 }), [{ x: -2, y: -1 }], "negative coordinates, no width on a west edge");
    assert.deepEqual(StreetIndex.tilesCovering({ s: 51.03, w: 13.7, n: 51.04, e: 13.75 }), [{ x: 548, y: 2041 }, { x: 549, y: 2041 }]);
    for (const x of [1, 7, 548, 549, -3]) for (const y of [3, 6, 2040, -7]) {
      assert.deepEqual(StreetIndex.tilesCovering(StreetIndex.tileBounds({ x, y })), [{ x, y }], `tile ${x},${y} maps back to itself`);
    }
    assert.equal(StreetIndex.tileKey("bike", 548, 2040), "bike:548:2040");
  });
  await testCase(async () => { // a bike request after a run fetch makes no call; a run request after a bike fetch does
    let kinds = [];
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles, kind) => { kinds.push(kind); return new Map(tiles.map((t) => [t.x + ":" + t.y, { ways: [], groups: {} }])); } });
    await s.ensureRects(rect, "run");
    await s.ensureRects(rect, "bike");
    assert.deepEqual(kinds, ["run"]);
    kinds = [];
    const t = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles, kind) => { kinds.push(kind); return new Map(tiles.map((x) => [x.x + ":" + x.y, { ways: [], groups: {} }])); } });
    await t.ensureRects(rect, "bike");
    await t.ensureRects(rect, "run");
    await t.ensureRects(rect, "run");
    assert.deepEqual(kinds, ["bike", "run"], "the run fetch is remembered next to the bike fetch");
  });
  await testCase(async () => { // a rect over one fetched and one new tile asks only for the new one; overlapping rects ask for each tile once
    const asked = [];
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles) => { asked.push(tiles.map((t) => t.x + ":" + t.y)); return new Map(tiles.map((t) => [t.x + ":" + t.y, { ways: [], groups: {} }])); } });
    await s.ensureRects([{ s: 51.01, w: 13.71, n: 51.02, e: 13.72 }], "run");
    await s.ensureRects([{ s: 51.01, w: 13.71, n: 51.02, e: 13.78 }, { s: 51.01, w: 13.76, n: 51.02, e: 13.89 }], "run");
    assert.deepEqual(asked[0], ["548:2040"]);
    assert.deepEqual(asked[1].slice().sort(), ["549:2040", "550:2040", "551:2040", "552:2040", "553:2040", "554:2040", "555:2040"]);
  });
  await testCase(async () => { // a source that answers some tiles and leaves one out: the answered tile is kept, the call says what is missing
    const full = { ways: [{ id: 1, nodes: [1, 2], geometry: [{ lat: 51.01, lon: 13.74 }, { lat: 51.011, lon: 13.74 }] }], groups: {} };
    const asked = [];
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles) => { asked.push(tiles.map((t) => t.x + ":" + t.y)); return new Map([["549:2040", full]]); } });
    const err = await s.ensureRects([{ s: 51.01, w: 13.74, n: 51.02, e: 13.76 }], "run").then(() => null, (e) => e);
    assert.match(err.message, /no answer for tile 550:2040 \(run\)/);
    assert.deepEqual([err.done, err.total, err.reason], [1, 2, "streets-partial"]);
    assert.deepEqual([s.ways.length, s.tiles.size, s.version], [1, 1, 1]);
    await s.ensureRects([{ s: 51.01, w: 13.74, n: 51.02, e: 13.76 }], "run").catch(() => {});
    assert.deepEqual(asked[1], ["550:2040"], "the retry asks only the missing tile");
  });
  await testCase(async () => { // an answer that is not a whole Overpass answer is the server's failure, never a TypeError (a bug) and never "covered"
    const tiles = [T(548, 2040)];
    const cases = {
      "null": null, "a string": "busy", "a number": 3, "an array": [], "no elements": {}, "elements not a list": { elements: {} },
      "cut after the geometry": { elements: [way(1)] },
      "six of seven counts": { elements: [way(1), ...EMPTY.slice(1)] },
    };
    for (const [name, body] of Object.entries(cases)) {
      let err;
      try { StreetIndex.splitAnswer(body, tiles); } catch (e) { err = e; }
      assert.ok(err && !(err instanceof TypeError), name + " throws a server failure");
      assert.equal(err.reason, "server", name);
    }
    assert.equal(StreetIndex.splitAnswer({ elements: EMPTY }, tiles).get("548:2040").ways.length, 0, "an empty area still answers whole");
    // through a run: the answer is not stored and the tile is not covered
    for (const body of [null, {}, { elements: [way(1)] }]) {
      global.fetch = async () => ({ ok: true, status: 200, json: async () => body });
      const s = new StreetIndex({ newFrac: () => 1 });
      const err = await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.01, e: 13.71 }], "run").then(() => null, (e) => e);
      assert.ok(StreetIndex.isDownloadError(err), "a download failure, not a bug: " + err);
      assert.equal(err.reason, "server");
      assert.equal(s.tiles.size, 0);
    }
  });
  await testCase(async () => { // a way is in every tile its segments cross, also a tile none of its vertices lies in
    const long = { type: "way", id: 5, nodes: [50, 51], geometry: [{ lat: 51.01, lon: 13.71 }, { lat: 51.01, lon: 13.76 }] };
    // a diagonal over a 3x3 block of tiles: its bounding box holds all nine, the line crosses five
    const diag = { type: "way", id: 6, nodes: [60, 61], geometry: [{ lat: 51.001, lon: 13.703 }, { lat: 51.072, lon: 13.774 }] };
    const tiles = [];
    for (let y = 2040; y <= 2042; y++) for (let x = 548; x <= 550; x++) tiles.push(T(x, y));
    const out = StreetIndex.splitAnswer({ elements: [long, diag, count, ...ids(5, 6), ...EMPTY.slice(1)] }, tiles);
    const where = (id) => [...out.entries()].filter(([, a]) => a.ways.some((w) => w.id === id)).map(([k]) => k).sort();
    assert.deepEqual(where(5), ["548:2040", "549:2040", "550:2040"], "the middle tile has no vertex of the way");
    assert.deepEqual(where(6), ["548:2040", "549:2040", "549:2041", "550:2041", "550:2042"], "only the tiles the line crosses");
    assert.deepEqual(out.get("549:2040").groups.bike, [5, 6], "the id lists follow the way into the tile");
    assert.deepEqual(out.get("550:2040").groups.bike, [5]);
  });
  await testCase(async () => { // a source that leaves a requested tile out is an error, and nothing is recorded as fetched
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async () => new Map() });
    const err = await s.ensureRects(rect, "run").then(() => null, (e) => e);
    assert.match(err.message, /no answer/);
    assert.equal(err.reason, "server", "a tile left out is the source's failure, so the page can word it");
    assert.equal(s.tiles.size, 0);
    assert.equal(s.version, 0);
  });
  await testCase(async () => { // an answer over several tiles is split per tile: a way over a tile edge lands in both tiles, ids filtered per tile
    const wide = { type: "way", id: 7, nodes: [70, 71], geometry: [{ lat: 51.01, lon: 13.74 }, { lat: 51.01, lon: 13.76 }] };
    const west = { type: "way", id: 8, nodes: [80, 81], geometry: [{ lat: 51.02, lon: 13.73 }, { lat: 51.02, lon: 13.735 }] };
    const lost = { type: "way", id: 9, nodes: [90, 91], geometry: [{ lat: 51.3, lon: 13.0 }, { lat: 51.3, lon: 13.01 }] };
    // geometry, then bike, road, car, oneWay, reverseWay, bikeBoth, motorway
    const tiles = [{ x: 549, y: 2040 }, { x: 550, y: 2040 }];
    const out = StreetIndex.splitAnswer({ elements: [wide, west, lost, count, ...ids(7, 8), count, ...ids(7), count, count, ...ids(8, 9), count, count, count] }, tiles);
    assert.deepEqual([...out.keys()], ["549:2040", "550:2040"]);
    assert.deepEqual(out.get("549:2040").ways.map((w) => w.id), [7, 8, 9], "7 straddles, 8 is inside, 9 matches no tile and goes to the first");
    assert.deepEqual(out.get("550:2040").ways.map((w) => w.id), [7]);
    assert.deepEqual(out.get("549:2040").groups.bike, [7, 8]);
    assert.deepEqual(out.get("550:2040").groups.bike, [7]);
    assert.deepEqual(out.get("549:2040").groups.road, [7]);
    assert.deepEqual(out.get("550:2040").groups.road, [7], "the straddling way carries its ids into both tiles");
    assert.deepEqual(out.get("549:2040").groups.oneWay, [8, 9]);
    assert.deepEqual(out.get("550:2040").groups.oneWay, []);
    assert.deepEqual(Object.keys(out.get("550:2040").groups), ["bike", "road", "car", "oneWay", "reverseWay", "bikeBoth", "motorway"]);
    assert.equal(structuredClone(out.get("549:2040")).ways.length, 3, "an answer is structured-clone friendly");
    // the index takes the straddling way once
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async () => out });
    await s.ensureRects([{ s: 51.0, w: 13.725, n: 51.025, e: 13.775 }], "bike");
    assert.deepEqual(s.ways.map((w) => w.id).sort(), [7, 8, 9]);
    assert.equal(s.version, 2, "one version bump per tile read");
  });
  await testCase(async () => { // pins the query text the bench cache is keyed on. The hash covers the timeout header too, but the
    // bench cache ignores it: a hash change from anything else means every saved answer misses
    const boxes = [{ s: 51, w: 13.7, n: 51.01, e: 13.71 }, { s: 51.2, w: 13.8, n: 51.21, e: 13.9 }];
    assert.ok(StreetIndex.rectQuery(boxes, "run").startsWith("[out:json][timeout:25];"), "the server's run is capped at 25 s, under the client's guards");
    const sha = (kind) => crypto.createHash("sha1").update(StreetIndex.rectQuery(boxes, kind)).digest("hex");
    assert.equal(sha("run"), "822a328d1c8f332ec55d2e363755ba4075c475f2");
    assert.equal(sha("bike"), "e3620d77390907388c5540fba2593f2325f19077");
    replyWith({ elements: EMPTY });
    await StreetIndex.overpassFetch([{ x: 548, y: 2040 }], "run");
    assert.equal(sent, "data=" + StreetIndex.rectQuery([StreetIndex.tileBounds({ x: 548, y: 2040 })], "run"), "the default source asks for the tile's bounds");
  });
  await testCase(async () => { // four uncovered tiles of one 2x2 block are one request over the block's box, split back per tile
    const asked = tileServer();
    const s = new StreetIndex({ newFrac: () => 1 });
    const progress = [];
    await s.ensureRects([{ s: 51.02, w: 13.72, n: 51.04, e: 13.74 }], "run", { onProgress: (p) => progress.push(p.done) });
    assert.deepEqual(asked, [span(548, 2040, 549, 2041)]);
    assert.deepEqual([s.ways.length, s.tiles.size, progress], [4, 4, [0, 1, 2, 3, 4]]);
  });
  await testCase(async () => { // eight missing tiles are two requests, one per 2x2 block, nearest block first, each tile handed over on its own
    const asked = tileServer();
    const got = [];
    const tiles = [T(549, 2040), T(550, 2040), T(549, 2041), T(550, 2041), T(548, 2040), T(551, 2040), T(548, 2041), T(551, 2041)];
    const out = await StreetIndex.overpassFetch(tiles, "run", (t, answer) => got.push([t.x + ":" + t.y, answer.ways.length]));
    assert.deepEqual(asked, [span(548, 2040, 549, 2041), span(550, 2040, 551, 2041)]);
    assert.deepEqual(got, [["549:2040", 1], ["549:2041", 1], ["548:2040", 1], ["548:2041", 1], ["550:2040", 1], ["550:2041", 1], ["551:2040", 1], ["551:2041", 1]]);
    assert.equal(out.size, 8);
  });
  await testCase(async () => { // a request never mixes 2x2 blocks: blocks go nearest tile first, and a block's missing tiles are asked
    // as their rectangle when they fill one, else as the whole block's box
    const asked = tileServer();
    await StreetIndex.overpassFetch([T(548, 2040), T(550, 2040), T(549, 2040), T(552, 2040), T(549, 2041), T(548, 2041), T(551, 2040)], "run");
    assert.deepEqual(asked, [span(548, 2040, 549, 2041), span(550, 2040, 551, 2040), box(552, 2040)]);
    asked.length = 0;
    await StreetIndex.overpassFetch([T(548, 2040), T(551, 2041)], "run");
    assert.deepEqual(asked, [box(548, 2040), box(551, 2041)]);
    asked.length = 0;
    const got = [];
    await StreetIndex.overpassFetch([T(549, 2041), T(548, 2040)], "run", (t) => got.push(t.x + ":" + t.y));
    assert.deepEqual(asked, [span(548, 2040, 549, 2041)], "a diagonal pair asks its whole block");
    assert.deepEqual(got.slice(0, 2), ["549:2041", "548:2040"], "the tiles asked for come first");
    assert.deepEqual(got.slice(2).sort(), ["548:2041", "549:2040"], "the block's other tiles come too");
  });
  await testCase(async () => { // the second of two requests fails: the first block's tiles are kept, and the retry asks only the other block
    let failing = true;
    const asked = tileServer((n) => failing && n === 2 && 500);
    const s = new StreetIndex({ newFrac: () => 1 });
    const r = [{ s: 51.0, w: 13.7, n: 51.05, e: 13.79 }];
    const err = await s.ensureRects(r, "run").then(() => null, (e) => e);
    assert.ok(err, "a run with a tile missing rejects");
    assert.deepEqual([err.done, err.total, err.reason], [4, 8, "streets-partial"]);
    assert.equal(err.cause.reason, "server", "the Overpass error is the cause");
    assert.deepEqual(asked, [span(548, 2040, 549, 2041), span(550, 2040, 551, 2041)]);
    assert.deepEqual([s.covered(51.01, 13.74), s.covered(51.04, 13.71), s.covered(51.01, 13.76)], [true, true, false]);
    failing = false;
    asked.length = 0;
    await s.ensureRects(r, "run");
    assert.deepEqual(asked, [span(550, 2040, 551, 2041)]);
    assert.equal(s.ways.length, 8);
  });
  await testCase(async () => { // the default source sends nothing new after a failed request that is not busy; nothing arrived, so
    // the error carries the cause's reason
    const asked = tileServer(() => 500);
    const tiles = [T(548, 2040), T(549, 2040), T(548, 2041), T(549, 2041), T(550, 2040), T(552, 2040)];
    const err = await StreetIndex.overpassFetch(tiles, "run").then(() => null, (e) => e);
    assert.equal(asked.length, 2, "the two overpass-api.de takes at once without a key, none for the third block");
    assert.deepEqual([err.done, err.total, err.reason, err.cause.reason], [0, 6, "server", "server"]);
  });
  await testCase(async () => { // busy is asked again after 15, 30 and 60 s, each wait in the progress; the fourth busy step ends the run
    const clock = fakeClock();
    const asked = tileServer((n) => n >= 2 && 502);
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const progress = [];
    const err = await s.ensureRects(fiveTiles, "run", { onProgress: (p) => progress.push(p) }).then(() => null, (e) => e);
    assert.deepEqual(asked, [span(548, 2040, 549, 2041), box(550, 2040), box(550, 2040), box(550, 2040), box(550, 2040)]);
    assert.deepEqual(clock.sleeps, [15000, 30000, 60000]);
    assert.deepEqual([err.done, err.total, err.reason, err.cause.reason], [4, 5, "streets-partial", "busy"]);
    const at = (done, waitUntil) => (waitUntil === undefined ? { done, total: 5 } : { done, total: 5, waitUntil });
    assert.deepEqual(progress, [at(0), at(1), at(2), at(3), at(4), at(4, 15000), at(4), at(4, 45000), at(4), at(4, 105000), at(4)]);
  });
  await testCase(async () => { // an answer to a request sent after a wait starts the count again: three blocks of a tile each, every
    // one busy three times; the first two complete together, then the third gets the whole schedule
    const clock = fakeClock();
    const busyCount = {};
    const asked = tileServer((n, b) => { busyCount[b] = (busyCount[b] || 0) + 1; return busyCount[b] <= 3 && 502; });
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const got = await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.02, e: 13.72 }, { s: 51.0, w: 13.75, n: 51.02, e: 13.77 }, { s: 51.0, w: 13.8, n: 51.02, e: 13.82 }], "run");
    assert.deepEqual([got.done, got.total, asked.length], [3, 3, 12]);
    assert.deepEqual(clock.sleeps, [15000, 30000, 60000, 15000, 30000, 60000]);
  });
  await testCase(async () => { // an answer that lands after a busy, from a request already open when the busy came, does not
    // start the count again: the fourth busy ends the run
    const clock = fakeClock();
    const srv = heldServer();
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const run = s.ensureRects(fiveTiles, "run").then(() => null, (e) => e);
    await settle();
    assert.deepEqual(srv.asked, [span(548, 2040, 549, 2041), box(550, 2040)]);
    await srv.reply(1, 502);
    await srv.reply(0);
    while (srv.pending.length) await srv.reply(0, 502);
    const err = await run;
    assert.deepEqual([err.done, err.total, err.cause.reason, srv.asked.length], [4, 5, "busy", 5]);
    assert.deepEqual(clock.sleeps, [15000, 30000, 60000]);
  });
  await testCase(async () => { // after the third busy wait the order the answers land in does not decide the outcome: two street
    // blocks asked again together, one busy and one bringing its tiles, in either order, restart the count and wait 15 s;
    // both busy end the run, but only once the second has landed
    for (const order of ["tiles, then busy", "busy, then tiles", "busy, then busy"]) {
      const clock = fakeClock();
      const srv = heldServer();
      const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
      let settled = false;
      const run = s.ensureRects(fiveTiles, "run").then((r) => r, (e) => e).finally(() => { settled = true; });
      await settle();
      for (let step = 0; step < 3; step++) { await srv.reply(0, 502); await srv.reply(0, 502); }
      assert.deepEqual([clock.sleeps, srv.pending.length], [[15000, 30000, 60000], 2], order);
      if (order === "tiles, then busy") { await srv.reply(0); await srv.reply(0, 502); }
      else {
        await srv.reply(0, 502);
        assert.equal(settled, false, order + ": the run waits for the request still open");
        await srv.reply(0, order === "busy, then tiles" ? undefined : 502);
      }
      const got = order === "busy, then busy" ? await run : null;
      if (got) {
        assert.deepEqual([got.done, got.total, got.cause.reason, clock.sleeps.length], [0, 5, "busy", 3], order);
        continue;
      }
      assert.deepEqual([clock.sleeps, srv.pending.length], [[15000, 30000, 60000, 15000], 1], order);
      await srv.reply(0);
      const whole = await run;
      assert.deepEqual([whole.done, whole.total], [5, 5], order);
    }
  });
  await testCase(async () => { // overpass-api.de held for its 406 and NextGIS busy: the run waits and asks NextGIS again
    withKey();
    const clock = fakeClock();
    global.Overpass._now = clock.now;
    let nextgis = 0;
    global.fetch = async (url, opts) => {
      if (!url.includes("nextgis")) return { ok: false, status: 406, json: async () => ({}) };
      nextgis++;
      if (nextgis <= 2) return { ok: false, status: nextgis === 1 ? 500 : 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ elements: tileElements(boxesOf(opts.body)) }) };
    };
    // NextGIS 500, overpass-api.de 406: held an hour
    assert.equal(await global.Overpass.post("data=x").then(() => null, (e) => e.reason), "blocked");
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const got = await s.ensureRects(rect, "run");
    assert.deepEqual([got.done, got.total, nextgis, clock.sleeps], [1, 1, 3, [15000]]);
  });
  await testCase(async () => { // a replaced run's posts still waiting for an Overpass slot are not sent, so the next run's go first
    const srv = heldServer();
    const first = new StreetIndex({ newFrac: () => 1 }).ensureRects(fiveTiles, "run");
    await settle();
    let stale = false;
    const replaced = new StreetIndex({ newFrac: () => 1 }).ensureRects([{ s: 51.1, w: 13.7, n: 51.15, e: 13.8 }], "run", { stale: () => stale })
      .then(() => null, (e) => e);
    await settle();
    assert.equal(srv.asked.length, 2, "the first run holds both of overpass-api.de's slots; the second's two posts wait");
    stale = true;
    const next = new StreetIndex({ newFrac: () => 1 }).ensureRects([{ s: 51.2, w: 13.7, n: 51.225, e: 13.725 }], "run");
    await settle();
    await srv.reply(0);
    await srv.reply(0);
    assert.deepEqual(srv.asked.slice(2), [box(548, 2048)], "the replaced run sent nothing; the next run's post went out");
    const err = await within(replaced);
    assert.deepEqual([err.done, err.total, err.cause.reason], [0, 8, "superseded"]);
    await srv.reply(0);
    assert.equal((await within(next)).done, 1);
    assert.equal((await within(first)).done, 5);
  });
  await testCase(async () => { // a busy with a later retry time waits until then
    const clock = fakeClock();
    global.Overpass._now = clock.now;
    let posts = 0;
    global.fetch = async () => {
      posts++;
      if (posts === 1) return { ok: false, status: 429, headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "100" : null) }, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ elements: EMPTY }) };
    };
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const progress = [];
    await s.ensureRects(rect, "run", { onProgress: (p) => progress.push(p) });
    assert.deepEqual([posts, clock.sleeps], [2, [100000]]);
    assert.deepEqual(progress[1], { done: 0, total: 1, waitUntil: 100000 });
  });
  await testCase(async () => { // a wait that would end past the run deadline is not waited: the run ends there, busy
    const clock = fakeClock();
    const asked = tileServer(() => 502);
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const err = await s.ensureRects(rect, "run", { deadlineMs: 40000 }).then(() => null, (e) => e);
    assert.deepEqual([asked.length, clock.sleeps], [2, [15000]], "15 s fits in 40 s, 15 + 30 s does not");
    assert.deepEqual([err.done, err.total, err.reason], [0, 1, "busy"]);
  });
  await testCase(async () => { // a run superseded while it waits out a busy server asks nothing further
    const clock = fakeClock();
    const asked = tileServer((n) => n >= 2 && 502);
    let stale = false;
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: async (ms) => { await clock.sleep(ms); stale = true; } });
    const err = await s.ensureRects(fiveTiles, "run", { stale: () => stale }).then(() => null, (e) => e);
    assert.equal(asked.length, 2, "no request after the wait");
    assert.ok(StreetIndex.isDownloadError(err));
    assert.equal(err.cause.reason, "superseded");
  });
  await testCase(async () => { // a run superseded once a request has answered asks for no further block, and keeps the one still
    // open; one already stale asks nothing
    const asked = tileServer();
    let stale = false;
    const s = new StreetIndex({ newFrac: () => 1 });
    const err = await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.05, e: 13.84 }], "run", { stale: () => stale, onProgress: (p) => { if (p.done === 4) stale = true; } }).then(() => null, (e) => e);
    assert.equal(asked.length, 2, "the two sent together, none for the third block");
    assert.deepEqual([err.done, err.total, err.cause.reason], [8, 12, "superseded"]);
    asked.length = 0;
    const err2 = await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "run", { stale: () => true }).then(() => null, (e) => e);
    assert.deepEqual([asked.length, err2.cause.reason], [0, "superseded"]);
  });
  await testCase(async () => { // 16 missing tiles in 4 blocks: four requests open on NextGIS together, never more; a block's tiles
    // count as soon as it lands; the same rects again ask nothing
    withKey();
    const srv = heldServer();
    const s = new StreetIndex({ newFrac: () => 1 });
    const progress = [];
    const run = s.ensureRects(sixteen, "run", { onProgress: (p) => progress.push(p) });
    await settle();
    assert.equal(srv.pending.length, 4, "one request per block, all four open at once");
    assert.deepEqual(srv.asked.slice().sort(), [span(548, 2040, 549, 2041), span(550, 2040, 551, 2041), span(548, 2042, 549, 2043), span(550, 2042, 551, 2043)].sort());
    await srv.reply(2);
    assert.deepEqual(progress[progress.length - 1], { done: 4, total: 16 });
    while (srv.pending.length) await srv.reply(0);
    assert.deepEqual(await run, { done: 16, total: 16, missing: [] });
    assert.equal(srv.most.nextgis, 4);
    assert.deepEqual(await s.ensureRects(sixteen, "run"), { done: 16, total: 16, missing: [] });
    assert.equal(srv.asked.length, 4, "a repeat makes no request");
  });
  await testCase(async () => { // overpass-api.de takes two at once, alone without a key, and when every request falls back from NextGIS
    for (const key of [null, KEY]) {
      if (key) global.crossfogNextgisKey = key;
      const srv = heldServer(key ? { nextgis: 500 } : null);
      const run = new StreetIndex({ newFrac: () => 1 }).ensureRects(sixteen, "run");
      await settle();
      assert.equal(srv.pending.length, 2, "two open on overpass-api.de, key " + !!key);
      while (srv.pending.length) await srv.reply(0);
      assert.equal((await run).done, 16);
      assert.deepEqual([srv.most.main, srv.most.nextgis, srv.asked.length], [2, undefined, 4]);
    }
  });
  await testCase(async () => { // a ragged block asks its whole box: the extra tile is stored and read like any other, but not counted
    const asked = tileServer();
    const store = global.TileStore.memory({ maxEntries: 10 });
    const cache = global.StreetCache.create({ store, network: StreetIndex.overpassFetch, now: () => 0 });
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: cache.fetchStreets });
    const progress = [];
    // an L of three tiles in the block 548..549 x 2040..2041: 548:2040, 549:2040, 548:2041
    const r = [{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }, { s: 51.025, w: 13.7, n: 51.05, e: 13.725 }];
    const got = await s.ensureRects(r, "run", { onProgress: (p) => progress.push(p.done + "/" + p.total) });
    assert.deepEqual(asked, [span(548, 2040, 549, 2041)]);
    assert.deepEqual([got.done, got.total, progress], [3, 3, ["0/3", "1/3", "2/3", "3/3"]]);
    assert.ok(await store.get("2:run:549:2041"), "the extra tile is in the store");
    assert.equal(s.tiles.size, 4);
    await s.ensureRects([{ s: 51.025, w: 13.725, n: 51.05, e: 13.75 }], "run");
    assert.equal(asked.length, 1, "a run over the extra tile asks nothing");
  });
  await testCase(async () => { // a ragged block's extra tile the index already holds is not read again
    tileServer();
    const s = new StreetIndex({ newFrac: () => 1 });
    await s.ensureRects([{ s: 51.025, w: 13.725, n: 51.05, e: 13.75 }], "run");
    let reads = 0;
    const read = s._read.bind(s);
    s._read = (answer, from) => { reads++; return read(answer, from); };
    await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }, { s: 51.025, w: 13.7, n: 51.05, e: 13.725 }], "run");
    assert.equal(reads, 3);
  });
  await testCase(async () => { // one of four open requests fails: the other three finish, their tiles reach the index and the store,
    // and no further block is sent
    withKey();
    const srv = heldServer({ main: 500 });
    const store = global.TileStore.memory({ maxEntries: 100 });
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: global.StreetCache.create({ store, network: StreetIndex.overpassFetch, now: () => 0 }).fetchStreets });
    const run = s.ensureRects(twentyFour, "run").then(() => null, (e) => e);
    await settle();
    assert.equal(srv.pending.length, 4);
    await srv.reply(1, 500);
    assert.equal(srv.asked.length, 4, "no request after the failure");
    while (srv.pending.length) await srv.reply(0);
    const err = await run;
    assert.equal(srv.asked.length, 4);
    assert.deepEqual([err.done, err.total, err.reason, err.cause.reason], [12, 24, "streets-partial", "server"]);
    assert.equal(s.tiles.size, 12);
    let stored = 0;
    for (const t of twentyFour.flatMap((r) => StreetIndex.tilesCovering(r))) if (await store.get("2:run:" + t.x + ":" + t.y)) stored++;
    assert.equal(stored, 12, "the three blocks that landed are in the store");
  });
  await testCase(async () => { // four busy answers at the same moment are one step of the schedule: one 15 s wait, then the four again
    withKey();
    const clock = fakeClock();
    global.Overpass._now = clock.now;
    const srv = heldServer({ main: 502 });
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const run = s.ensureRects(sixteen, "run");
    await settle();
    for (const p of srv.pending.splice(0)) p.answer(502);
    await settle();
    assert.deepEqual([clock.sleeps, srv.pending.length], [[15000], 4]);
    while (srv.pending.length) await srv.reply(0);
    assert.equal((await run).done, 16);
  });
  await testCase(async () => { // a run gone stale sends nothing new; the requests already open finish and their tiles are kept
    withKey();
    const srv = heldServer();
    let stale = false;
    const s = new StreetIndex({ newFrac: () => 1 });
    const run = s.ensureRects(twentyFour, "run", { stale: () => stale }).then(() => null, (e) => e);
    await settle();
    stale = true;
    while (srv.pending.length) await srv.reply(0);
    const err = await run;
    assert.equal(srv.asked.length, 4);
    assert.deepEqual([err.done, err.total, err.cause.reason], [16, 24, "superseded"]);
  });
  await testCase(async () => { // the busy wait is reported only once no request is open, and not at all when the open ones outlast it
    for (const lastAt of [0, 20000]) {
      withKey();
      const clock = fakeClock();
      global.Overpass._now = clock.now;
      const srv = heldServer({ main: 502 });
      const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
      const progress = [];
      const run = s.ensureRects(sixteen, "run", { onProgress: (p) => progress.push(p) });
      await settle();
      await srv.reply(0, 502);
      await srv.reply(0);
      await srv.reply(0);
      assert.ok(!progress.some((p) => "waitUntil" in p), "no busy text while a request is open");
      clock.t = lastAt;
      await srv.reply(0);
      const waits = progress.filter((p) => "waitUntil" in p);
      assert.deepEqual(waits, lastAt ? [] : [{ done: 12, total: 16, waitUntil: 15000 }]);
      assert.deepEqual(clock.sleeps, lastAt ? [] : [15000]);
      assert.equal(srv.pending.length, 1, "the busy block is asked again");
      await srv.reply(0);
      assert.equal((await run).done, 16);
    }
  });
  await testCase(async () => { // a throw from onTile that is not the caller's stop (a bug) comes out of the default source unchanged
    tileServer();
    const bug = new TypeError("bug");
    const err = await StreetIndex.overpassFetch([{ x: 548, y: 2040 }, { x: 549, y: 2040 }], "run", () => { throw bug; }).then(() => null, (e) => e);
    assert.equal(err, bug);
  });
  await testCase(async () => { // a bug thrown while reading a tile comes out of ensureRects as itself, not as a download error
    tileServer();
    const s = new StreetIndex({ newFrac: () => 1 });
    s._read = () => { throw new TypeError("bug"); };
    const err = await s.ensureRects(rect, "run").then(() => null, (e) => e);
    assert.ok(err instanceof TypeError);
    assert.equal(err.total, undefined);
  });
  await testCase(async () => { // a request that cannot be built (a bug) rejects the run as itself and the requests already open still
    // hand their tiles over; the run never hangs. Call 1 fails with nothing open, call 2 is the first pump's
    // second request (cap 2 without a key), call 3 is a later pump's, run from an answer's handler
    const real = StreetIndex.rectQuery;
    try {
      for (const failAt of [1, 2, 3]) {
        tileServer();
        const bug = new TypeError("bug");
        let calls = 0;
        StreetIndex.rectQuery = (...a) => { if (++calls === failAt) throw bug; return real(...a); };
        const heard = [];
        const err = await within(StreetIndex.overpassFetch(StreetIndex.tilesCovering(twelve[0]), "run", (t) => heard.push(t.x + ":" + t.y)).then(() => null, (e) => e));
        assert.equal(err, bug, `rectQuery throwing on call ${failAt}`);
        assert.ok(failAt === 1 ? heard.length === 0 : heard.length >= 4, "the requests already open hand their tiles over");
      }
    } finally { StreetIndex.rectQuery = real; }
  });
  await testCase(async () => { // through ensureRects the same bug is the run's rejection as itself, not a download error
    const real = StreetIndex.rectQuery;
    try {
      tileServer();
      const bug = new TypeError("bug");
      let calls = 0;
      StreetIndex.rectQuery = (...a) => { if (++calls === 3) throw bug; return real(...a); };
      const err = await within(new StreetIndex({ newFrac: () => 1 }).ensureRects(twelve, "run").then(() => null, (e) => e));
      assert.equal(err, bug);
    } finally { StreetIndex.rectQuery = real; }
  });
  await testCase(async () => { // a bug thrown by the caller's onProgress or by sleep during a busy wait rejects as itself
    for (const where of ["onProgress", "sleep"]) {
      const clock = fakeClock();
      tileServer((n) => n >= 2 && 502);
      const bug = new TypeError("bug in " + where);
      const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: where === "sleep" ? async () => { throw bug; } : clock.sleep });
      const opts = where === "onProgress" ? { onProgress: (p) => { if ("waitUntil" in p) throw bug; } } : {};
      const err = await within(s.ensureRects(fiveTiles, "run", opts).then(() => null, (e) => e));
      assert.equal(err, bug, where);
      assert.equal(StreetIndex.isDownloadError(err), false);
    }
  });
  await testCase(async () => { // only a failure carrying a street reason is a download failure: a source's other throw rejects as itself
    const bug = new TypeError("bug");
    const bad = await new StreetIndex({ newFrac: () => 1, fetchStreets: async () => { throw bug; } }).ensureRects(rect, "run").then(() => null, (e) => e);
    assert.equal(bad, bug);
    for (const reason of ["busy", "blocked", "stalled", "offline", "server"]) {
      const cause = Object.assign(new Error("x"), { reason });
      const err = await new StreetIndex({ newFrac: () => 1, fetchStreets: async () => { throw cause; } }).ensureRects(rect, "run").then(() => null, (e) => e);
      assert.ok(StreetIndex.isDownloadError(err), reason);
      assert.equal(err.cause, cause);
    }
    // overpassFetch does not dress a bug in reading an answer as a download failure either
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ elements: EMPTY }) });
    const real = StreetIndex.splitAnswer;
    StreetIndex.splitAnswer = () => { throw bug; };
    try {
      const err = await StreetIndex.overpassFetch([T(548, 2040)], "run").then(() => null, (e) => e);
      assert.equal(err, bug);
    } finally { StreetIndex.splitAnswer = real; }
  });
  await testCase(async () => { // a bug in the code around the request ends the run as itself, never pending. The real async Overpass.post
    // cannot throw at once, so that stand-in only exercises the try around pump's send loop; the two cases
    // after it force defensive paths (an answer reader returning nothing, and a rejection with no value,
    // which the real post never sends): the answer-reader case rejects with the TypeError it throws, the no-value rejection with undefined
    const realPost = global.Overpass.post, realSplit = StreetIndex.splitAnswer;
    const bug = new TypeError("bug");
    try {
      global.Overpass.post = () => { throw bug; };
      assert.equal(await within(StreetIndex.overpassFetch([T(548, 2040)], "run").then(() => null, (e) => e)), bug);
      global.Overpass.post = realPost;
      tileServer();
      StreetIndex.splitAnswer = () => undefined;
      const err = await within(StreetIndex.overpassFetch([T(548, 2040)], "run").then(() => null, (e) => e));
      assert.ok(err instanceof TypeError, "reading the answer's tiles threw");
      global.Overpass.post = () => Promise.reject(undefined);
      assert.equal(await within(StreetIndex.overpassFetch([T(548, 2040)], "run").then(() => "resolved", (e) => e)), undefined);
    } finally { global.Overpass.post = realPost; StreetIndex.splitAnswer = realSplit; }
  });
  await testCase(async () => { // a source that swallows the caller's throw and resolves anyway still hands the bug on
    const bug = new TypeError("bug");
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles, kind, onTile) => {
      try { onTile(tiles[0], { ways: [], groups: {} }); } catch (e) { /* swallowed */ }
      return new Map();
    } });
    s._read = () => { throw bug; };
    assert.equal(await s.ensureRects(rect, "run").then(() => null, (e) => e), bug);
  });
  await testCase(async () => { // a bug building a request, then a bug reading a tile an open request brought: the first is the rejection
    const real = StreetIndex.rectQuery;
    try {
      tileServer();
      const first = new TypeError("first");
      let calls = 0;
      StreetIndex.rectQuery = (...a) => { if (++calls === 2) throw first; return real(...a); };
      const s = new StreetIndex({ newFrac: () => 1 });
      s._read = () => { throw new RangeError("second"); };
      assert.equal(await within(s.ensureRects(twelve, "run").then(() => null, (e) => e)), first);
    } finally { StreetIndex.rectQuery = real; }
  });
  await testCase(async () => { // several bugs in one run: the first is the rejection, so the class a caller logs is the first's
    tileServer();
    const first = new TypeError("first"), second = new RangeError("second");
    let n = 0;
    const s = new StreetIndex({ newFrac: () => 1 });
    s._read = () => { throw ++n === 1 ? first : second; };
    const err = await s.ensureRects(sixteen, "run").then(() => null, (e) => e);
    assert.equal(err, first);
  });
  await testCase(async () => { // the cause's retryAt is copied onto the error, and its reason when no tile arrived
    const cause = Object.assign(new Error("overpass HTTP 429"), { reason: "busy", retryAt: 12345 });
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async () => { throw cause; } });
    const err = await s.ensureRects(rect, "run").then(() => null, (e) => e);
    assert.deepEqual([err.done, err.total, err.reason, err.retryAt, err.cause], [0, 1, "busy", 12345, cause]);
  });
  await testCase(async () => { // a run past its deadline stops before the next request, with its progress
    const clock = { t: 0 };
    const src = slowSource(clock, 500000);
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: src.fetchStreets, now: () => clock.t });
    const progress = [];
    const r = [{ s: 51.0, w: 13.7, n: 51.025, e: 13.825 }];
    const err = await s.ensureRects(r, "run", { onProgress: (p) => progress.push(p) }).then(() => null, (e) => e);
    assert.equal(src.asked.length, 3, "past 20 min at the third tile (25 min): no fourth request");
    assert.deepEqual([err.done, err.total, err.reason, err.cause.reason], [3, 5, "streets-partial", "stalled"]);
    assert.deepEqual(progress, [0, 1, 2, 3].map((done) => ({ done, total: 5 })));
    const t = new StreetIndex({ newFrac: () => 1, fetchStreets: slowSource(clock, 30000).fetchStreets, now: () => clock.t });
    const err2 = await t.ensureRects(r, "run", { deadlineMs: 20000 }).then(() => null, (e) => e);
    assert.deepEqual([err2.done, err2.total], [1, 5], "opts.deadlineMs sets the deadline");
  });
  await testCase(async () => { // requests answered past the deadline keep every tile they brought, then nothing further is asked
    const clock = { t: 0 };
    const asked = tileServer();
    const serve = global.fetch;
    global.fetch = async (url, opts) => { clock.t += 1300000; return serve(url, opts); }; // past 20 min
    const s = new StreetIndex({ newFrac: () => 1, now: () => clock.t });
    const err = await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.05, e: 13.84 }], "run").then(() => null, (e) => e);
    assert.equal(asked.length, 2, "the two sent together, none for the third block");
    assert.deepEqual([err.done, err.total, err.reason, err.cause.reason], [8, 12, "streets-partial", "stalled"]);
  });
  await testCase(async () => { // every tile in, though the run stopped on the way (its deadline, here): the run is whole
    const clock = { t: 0 };
    tileServer();
    const serve = global.fetch;
    global.fetch = async (url, opts) => { clock.t += 1300000; return serve(url, opts); };
    const s = new StreetIndex({ newFrac: () => 1, now: () => clock.t });
    const logged = [], orig = console.warn;
    console.warn = (...a) => logged.push(a);
    try { assert.deepEqual(await s.ensureRects(fiveTiles, "run"), { done: 5, total: 5, missing: [] }); } finally { console.warn = orig; }
    assert.deepEqual(logged, [], "the run's own deadline is not a source failure");
  });
  await testCase(async () => { // a source that fails once every tile it was asked for is in: the run is whole, the error's class is logged, never its text
    const cause = Object.assign(new RangeError("overpass: busy near 548:2040"), { reason: "busy" });
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles, kind, onTile) => {
      for (const t of tiles) onTile(t, { ways: [], groups: {} });
      throw cause;
    } });
    const logged = [], orig = console.warn;
    console.warn = (...a) => logged.push(a);
    try { assert.deepEqual(await s.ensureRects(fiveTiles, "run"), { done: 5, total: 5, missing: [] }); } finally { console.warn = orig; }
    assert.deepEqual(logged, [["[streets] a street source failed after every piece it was asked for arrived", "RangeError", "busy"]]);
  });
  await testCase(async () => { // the same failure on a run replaced meanwhile: it rejects superseded and logs nothing
    let replaced = false;
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles, kind, onTile) => {
      for (const t of tiles) onTile(t, { ways: [], groups: {} });
      replaced = true;
      throw Object.assign(new RangeError("busy"), { reason: "busy" });
    } });
    const logged = [], orig = console.warn;
    console.warn = (...a) => logged.push(a);
    let err;
    try { await s.ensureRects(fiveTiles, "run", { stale: () => replaced }); } catch (e) { err = e; } finally { console.warn = orig; }
    assert.ok(StreetIndex.isSuperseded(err));
    assert.deepEqual(logged, []);
  });
  await testCase(async () => { // a run replaced while a failure was already the first stop is still superseded, not worded as the failure
    let replaced = false;
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles, kind, onTile) => {
      onTile(tiles[0], { ways: [], groups: {} });
      replaced = true;
      throw Object.assign(new Error("x"), { reason: "server" });
    } });
    const err = await s.ensureRects(fiveTiles, "run", { stale: () => replaced }).then(() => null, (e) => e);
    assert.ok(StreetIndex.isSuperseded(err), "got " + (err && err.cause && err.cause.reason));
    assert.deepEqual([err.done, err.total], [1, 5], "what arrived is counted");
  });
  await testCase(async () => { // a source that fails after every tile arrived is dropped only when the failure is the run's deadline or a street failure: a bug wrapped in a download error is not
    const bug = new TypeError("bug");
    const handing = (error) => ({ newFrac: () => 1, fetchStreets: async (tiles, kind, onTile) => {
      for (const t of tiles) onTile(t, { ways: [], groups: {} });
      throw error;
    } });
    const wrapped = await new StreetIndex(handing(StreetIndex.downloadError(1, 1, bug, 1))).ensureRects(rect, "run").then(() => "resolved", (e) => e);
    assert.equal(wrapped, bug, "the bug is the rejection, as itself");
    const silent = { newFrac: () => 1, fetchStreets: async () => { throw StreetIndex.downloadError(0, 1, bug, 0); } };
    assert.equal(await new StreetIndex(silent).ensureRects(rect, "run").then(() => "resolved", (e) => e), bug, "also when a tile is missing");
    const logged = [], orig = console.warn;
    console.warn = (...a) => logged.push(a);
    try {
      const outage = StreetIndex.downloadError(1, 1, Object.assign(new Error("x"), { reason: "busy" }), 1);
      const whole = await new StreetIndex(handing(outage)).ensureRects(rect, "run");
      assert.deepEqual([whole.done, whole.total], [1, 1]);
    } finally { console.warn = orig; }
    assert.equal(logged.length, 1, "an outage after every tile arrived is still logged by class and reason");
  });
  await testCase(async () => { // a bug in Overpass.post, or a throw from the caller's wait that is not a street failure, rejects as itself
    const realPost = global.Overpass.post, bug = new TypeError("bug");
    try {
      global.Overpass.post = async () => { await null; throw bug; };
      assert.equal(await within(StreetIndex.overpassFetch([T(548, 2040)], "run").then(() => null, (e) => e)), bug);
      global.Overpass.post = realPost;
      global.fetch = async () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) });
      const stopped = await within(StreetIndex.overpassFetch([T(548, 2040)], "run", null, { wait: async () => { throw bug; } }).then(() => null, (e) => e));
      assert.equal(stopped, bug);
    } finally { global.Overpass.post = realPost; global.Overpass._reset(); }
  });
  await testCase(async () => { // a run replaced on an earlier answer rejects though the open requests landed every tile, which
    // are kept
    withKey();
    const srv = heldServer();
    let stale = false;
    const s = new StreetIndex({ newFrac: () => 1 });
    const run = s.ensureRects(sixteen, "run", { stale: () => stale }).then(() => null, (e) => e);
    await settle();
    await srv.reply(0);
    stale = true;
    while (srv.pending.length) await srv.reply(0);
    const err = await run;
    assert.deepEqual([srv.asked.length, err.done, err.total, err.cause.reason], [4, 16, 16, "superseded"]);
  });
  await testCase(async () => { // the last tile is kept even when it lands past the deadline: the check runs only while tiles remain
    const clock = { t: 0 };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: slowSource(clock, 30000).fetchStreets, now: () => clock.t });
    await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }], "run", { deadlineMs: 45000 });
    assert.equal(s.tiles.size, 2);
  });
  await testCase(async () => { // a retry over the same rects keeps the total and counts the tiles the index already holds as done
    // from the first report; the reason a failure carries is still chosen by the tiles read in that run
    const r = [{ s: 51.0, w: 13.7, n: 51.05, e: 13.775 }]; // 6 tiles
    const answer = { ways: [], groups: {} };
    const asked = [];
    let plan = { give: 3, stop: "stalled" };
    const fetchStreets = async (tiles, kind, onTile) => {
      asked.push(tiles.length);
      tiles.slice(0, plan.give).forEach((t) => onTile(t, answer));
      if (plan.stop) throw Object.assign(new Error("source stopped"), { reason: plan.stop });
      return new Map();
    };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets });
    const reports = [];
    const first = await s.ensureRects(r, "run", { onProgress: (p) => reports.push(p) }).then(() => null, (e) => e);
    assert.deepEqual([first.done, first.total, first.reason], [3, 6, "streets-partial"]);
    assert.deepEqual(reports[0], { done: 0, total: 6 });
    // nothing read in the retry, 3 tiles held: the cause's own reason, as when nothing was held
    plan = { give: 0, stop: "offline" };
    reports.length = 0;
    const second = await s.ensureRects(r, "run", { onProgress: (p) => reports.push(p) }).then(() => null, (e) => e);
    assert.deepEqual([second.done, second.total, second.reason, second.cause.reason], [3, 6, "offline", "offline"]);
    assert.deepEqual(reports, [{ done: 3, total: 6 }], "the first report already counts the held tiles");
    // one tile read in the retry: streets-partial, with the held tiles in the count
    plan = { give: 1, stop: "stalled" };
    reports.length = 0;
    const third = await s.ensureRects(r, "run", { onProgress: (p) => reports.push(p) }).then(() => null, (e) => e);
    assert.deepEqual([third.done, third.total, third.reason], [4, 6, "streets-partial"]);
    assert.deepEqual(reports.map((p) => p.done), [3, 4]);
    assert.deepEqual(asked, [6, 3, 3], "each retry asks only for what is missing");
    plan = { give: 2, stop: null };
    reports.length = 0;
    assert.deepEqual(await s.ensureRects(r, "run", { onProgress: (p) => reports.push(p) }), { done: 6, total: 6, missing: [] });
    assert.deepEqual(reports.map((p) => p.done), [4, 5, 6]);
    // everything held: nothing asked, nothing reported, all counted done
    reports.length = 0;
    assert.deepEqual(await s.ensureRects(r, "run", { onProgress: (p) => reports.push(p) }), { done: 6, total: 6, missing: [] });
    assert.deepEqual([reports, asked.length], [[], 4]);
  });
  await testCase(async () => { // every way a run can end short counts the held tiles, and takes its reason from the tiles read in that run
    const r = [{ s: 51.0, w: 13.7, n: 51.05, e: 13.775 }]; // 6 tiles, the first 3 held
    const answer = { ways: [], groups: {} };
    const clock = { t: 0 };
    const index = (fetchStreets) => {
      const s = new StreetIndex({ newFrac: () => 1, fetchStreets, now: () => clock.t });
      s._cover(StreetIndex.tilesOf(r).slice(0, 3), "run");
      return s;
    };
    const facts = (e) => [e.done, e.total, e.reason, e.cause.reason];
    const fail = (s, opts) => s.ensureRects(r, "run", opts).then(() => assert.fail("expected a rejection"), (e) => e);
    // the source leaves every asked tile out of its answer
    assert.deepEqual(facts(await fail(index(async () => new Map()))), [3, 6, "server", "server"]);
    // it answers two of three and leaves one out
    assert.deepEqual(facts(await fail(index(async (tiles, kind, onTile) => { tiles.slice(0, 2).forEach((t) => onTile(t, answer)); return new Map(); }))),
      [5, 6, "streets-partial", "server"]);
    // replaced before it asked anything
    const replaced = await fail(index(async () => assert.fail("no request")), { stale: () => true });
    assert.deepEqual(facts(replaced), [3, 6, "superseded", "superseded"]);
    assert.ok(StreetIndex.isDownloadError(replaced));
    // the deadline passes after the first tile of three
    const late = async (tiles, kind, onTile) => { clock.t = 50000; onTile(tiles[0], answer); };
    assert.deepEqual(facts(await fail(index(late), { deadlineMs: 45000 })), [4, 6, "streets-partial", "stalled"]);
    // an offline source with nothing read: no tile arrived, so no "streets-partial" however many are held
    assert.deepEqual(facts(await fail(index(async () => { throw Object.assign(new Error("x"), { reason: "offline" }); }))), [3, 6, "offline", "offline"]);
    assert.deepEqual(await new StreetIndex({ newFrac: () => 1 }).ensureRects([], "run"), { done: 0, total: 0, missing: [] });
  });
  await testCase(async () => { // a cache hit is not a download: an offline run in a partly cached area says offline,
    // and one piece downloaded before the network went makes it streets-partial; both count the hits as done
    const r = [{ s: 51.0, w: 13.7, n: 51.05, e: 13.775 }]; // 6 tiles
    const answer = { ways: [], groups: {} };
    const run = async (give) => {
      const store = global.TileStore.memory();
      for (const t of StreetIndex.tilesOf(r).slice(0, 3)) await store.put("2:run:" + t.x + ":" + t.y, { answer, fetchedAt: 0 });
      const network = async (tiles, kind, onTile) => {
        tiles.slice(0, give).forEach((t) => onTile(t, answer));
        throw Object.assign(new Error("offline"), { reason: "offline" });
      };
      const cache = global.StreetCache.create({ store, network, now: () => 1 });
      const s = new StreetIndex({ newFrac: () => 1, fetchStreets: cache.fetchStreets });
      return s.ensureRects(r, "run").then(() => assert.fail("expected a rejection"), (e) => e);
    };
    const offline = await run(0);
    assert.deepEqual([offline.done, offline.total, offline.reason, offline.cause.reason], [3, 6, "offline", "offline"]);
    const partial = await run(1);
    assert.deepEqual([partial.done, partial.total, partial.reason, partial.cause.reason], [4, 6, "streets-partial", "offline"]);
  });
  await testCase(async () => { // overlapping runs share a tile in flight: one request, and the second run resolves when it lands
    withKey();
    const srv = heldServer();
    const one = [{ s: 51.0, w: 13.7, n: 51.02, e: 13.72 }];
    const s = new StreetIndex({ newFrac: () => 1 });
    const reports = [];
    const first = s.ensureRects(one, "run");
    const second = s.ensureRects(one, "bike", { onProgress: (p) => reports.push(p) }); // a run tile stands in for bike
    await settle();
    assert.equal(srv.asked.length, 1, "the second run asks nothing of its own");
    await srv.reply(0);
    assert.deepEqual(await within(Promise.all([first, second])), [{ done: 1, total: 1, missing: [] }, { done: 1, total: 1, missing: [] }]);
    assert.deepEqual(reports, [{ done: 0, total: 1 }, { done: 1, total: 1 }]);
    assert.equal(s.inFlight.size, 0, "nothing left in flight");
  });
  await testCase(async () => { // a tile in flight for a run that gives it up is asked again by the run waiting for it
    const answer = { ways: [], groups: {} };
    const one = [{ s: 51.0, w: 13.7, n: 51.02, e: 13.72 }];
    const calls = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    // the first call waits for the gate and then, its run replaced, sends nothing; later calls answer
    const fetchStreets = async (tiles, kind, onTile, opts) => {
      calls.push(tiles.length);
      if (calls.length === 1) { await gate; if (opts.stale()) throw Object.assign(new Error("replaced"), { reason: "superseded" }); }
      tiles.forEach((t) => onTile(t, answer));
      return new Map();
    };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets });
    let replaced = false;
    const first = s.ensureRects(one, "run", { stale: () => replaced }).then(() => assert.fail("expected a rejection"), (e) => e);
    const second = s.ensureRects(one, "run");
    await settle();
    assert.deepEqual(calls, [1], "the second run waits for the first's tile");
    replaced = true;
    release();
    assert.ok(StreetIndex.isSuperseded(await within(first)));
    assert.deepEqual(await within(second), { done: 1, total: 1, missing: [] }, "not stopped by the other run going stale");
    assert.deepEqual(calls, [1, 1], "asked again once given up");
    assert.equal(s.inFlight.size, 0);
  });
  await testCase(async () => { // two runs waiting for a tile the first run gives up: one of them asks again, the other waits for it
    const answer = { ways: [], groups: {} };
    const one = [{ s: 51.0, w: 13.7, n: 51.02, e: 13.72 }];
    const calls = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchStreets = async (tiles, kind, onTile, opts) => {
      calls.push(tiles.length);
      if (calls.length === 1) { await gate; if (opts.stale()) throw Object.assign(new Error("replaced"), { reason: "superseded" }); }
      tiles.forEach((t) => onTile(t, answer));
      return new Map();
    };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets });
    let replaced = false;
    const first = s.ensureRects(one, "run", { stale: () => replaced }).then(() => assert.fail("expected a rejection"), (e) => e);
    const second = s.ensureRects(one, "run"), third = s.ensureRects(one, "bike");
    await settle();
    replaced = true;
    release();
    assert.ok(StreetIndex.isSuperseded(await within(first)));
    assert.deepEqual(await within(Promise.all([second, third])), [{ done: 1, total: 1, missing: [] }, { done: 1, total: 1, missing: [] }]);
    assert.deepEqual(calls, [1, 1], "asked again once, not once per waiting run");
    assert.equal(s.inFlight.size, 0);
  });
  await testCase(async () => { // a bug thrown by the caller's stale() while the run waits for another run's tile rejects as itself
    const answer = { ways: [], groups: {} };
    const one = [{ s: 51.0, w: 13.7, n: 51.02, e: 13.72 }];
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchStreets = async (tiles, kind, onTile) => { await gate; tiles.forEach((t) => onTile(t, answer)); return new Map(); };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets });
    const bug = new TypeError("stale() broke");
    let armed = false;
    const first = s.ensureRects(one, "run");
    const second = s.ensureRects(one, "run", { stale: () => { if (armed) throw bug; return false; } }).then(() => assert.fail("expected a rejection"), (e) => e);
    await settle();
    armed = true;
    release();
    assert.equal(await within(second), bug);
    await within(first);
  });
  await testCase(async () => { // a cache-only read beside a run with the tile in flight neither waits for it nor claims it
    const answer = { ways: [], groups: {} };
    const one = [{ s: 51.0, w: 13.7, n: 51.02, e: 13.72 }];
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchStreets = async (tiles, kind, onTile, opts) => {
      if (opts && opts.cacheOnly) return new Map();
      await gate; tiles.forEach((t) => onTile(t, answer)); return new Map();
    };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets });
    const run = s.ensureRects(one, "run");
    const [t] = StreetIndex.tilesOf(one);
    assert.deepEqual(await within(s.ensureRects(one, "run", { cacheOnly: true })), { done: 0, total: 1, missing: [t] });
    assert.equal(s.inFlight.size, 1, "only the run's claim");
    release();
    await within(run);
  });
  await testCase(async () => { // a run replaced while it waits for another run's tile rejects superseded; the other run still gets the tile
    const answer = { ways: [], groups: {} };
    const one = [{ s: 51.0, w: 13.7, n: 51.02, e: 13.72 }];
    let release, calls = 0;
    const gate = new Promise((r) => { release = r; });
    const fetchStreets = async (tiles, kind, onTile) => { calls++; await gate; tiles.forEach((t) => onTile(t, answer)); return new Map(); };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets });
    let replaced = false;
    const first = s.ensureRects(one, "run");
    const second = s.ensureRects(one, "run", { stale: () => replaced }).then(() => assert.fail("expected a rejection"), (e) => e);
    await settle();
    replaced = true;
    release();
    assert.ok(StreetIndex.isSuperseded(await within(second)));
    assert.deepEqual(await within(first), { done: 1, total: 1, missing: [] });
    assert.equal(calls, 1);
    assert.equal(s.tiles.size, 1);
  });
  await testCase(async () => { // a shared tile counts as downloaded only when the other run did not read it from the street
    // cache: an offline failure of the run's own call then says offline, not streets-partial
    const answer = { ways: [], groups: {} };
    const two = [{ s: 51.0, w: 13.7, n: 51.02, e: 13.75 }];
    const [a] = StreetIndex.tilesOf(two);
    const run = async (via) => {
      let releaseA, releaseB;
      const gateA = new Promise((r) => { releaseA = r; }), gateB = new Promise((r) => { releaseB = r; });
      const fetchStreets = async (tiles, kind, onTile) => {
        if (tiles[0].x === a.x) { await gateA; onTile(a, answer, via); return new Map(); }
        await gateB;
        throw Object.assign(new Error("offline"), { reason: "offline" });
      };
      const s = new StreetIndex({ newFrac: () => 1, fetchStreets });
      const first = s.ensureRects([StreetIndex.tileBounds(a)], "run");
      const second = s.ensureRects(two, "run").then(() => assert.fail("expected a rejection"), (e) => e);
      await settle();
      releaseA();
      await within(first);
      releaseB();
      const e = await within(second);
      return [e.done, e.total, e.reason, e.cause.reason];
    };
    assert.deepEqual(await run({ cached: true }), [1, 2, "offline", "offline"]);
    assert.deepEqual(await run(undefined), [1, 2, "streets-partial", "offline"]);
  });
  await testCase(async () => { // a busy wait reports the held tiles in its count too
    const clock = { t: 0 };
    const r = [{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }]; // 2 tiles
    const s = new StreetIndex({ newFrac: () => 1, now: () => clock.t, sleep: async (ms) => { clock.t += ms; },
      fetchStreets: async (tiles, kind, onTile, opts) => {
        if (tiles.length === 2) { onTile(tiles[0], { ways: [], groups: {} }); throw Object.assign(new Error("x"), { reason: "stalled" }); }
        assert.equal(await opts.wait(clock.t + 5000), true);
        onTile(tiles[0], { ways: [], groups: {} });
        return new Map();
      } });
    await s.ensureRects(r, "run").catch(() => {});
    const reports = [];
    await s.ensureRects(r, "run", { onProgress: (p) => reports.push(p) });
    assert.deepEqual(reports, [{ done: 1, total: 2 }, { done: 1, total: 2, waitUntil: 5000 }, { done: 1, total: 2 }, { done: 2, total: 2 }]);
  });
  await testCase(async () => { // a second run over ground the first one covered asks nothing and reports no progress
    const clock = { t: 0 };
    const src = slowSource(clock, 1000);
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: src.fetchStreets, now: () => clock.t });
    const r = [{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }];
    const first = [], second = [];
    await s.ensureRects(r, "run", { onProgress: (p) => first.push(p) });
    await s.ensureRects(r, "run", { onProgress: (p) => second.push(p) });
    assert.deepEqual(first, [0, 1, 2].map((done) => ({ done, total: 2 })));
    assert.deepEqual([second, src.asked.length], [[], 2], "a covered area is not shown as a download");
  });
  await testCase(async () => { // cache only: what the source holds is merged, the rest is listed as missing instead of rejected
    const asked = [], askedTiles = [];
    let held = null; // the source holds the first tile it is ever asked for, nothing else
    const fetchStreets = async (tiles, kind, onTile, opts) => {
      asked.push(opts);
      askedTiles.push(tiles);
      held = held || tiles[0];
      for (const t of tiles) if (t.x === held.x && t.y === held.y) onTile(t, { ways: [way(1)], groups: {} });
      return new Map();
    };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets });
    const r = [{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }];
    const got = await s.ensureRects(r, "run", { cacheOnly: true });
    assert.deepEqual(asked, [{ cacheOnly: true }], "the source is told not to use the network");
    assert.deepEqual([got.done, got.total, got.missing.length], [1, 2, 1]);
    assert.equal(s.tiles.size, 1, "only the tile that came is covered");
    assert.equal(s.ways.length, 1);
    const again = await s.ensureRects(r, "run", { cacheOnly: true });
    assert.deepEqual(askedTiles[1], got.missing, "the covered tile is not asked again");
    assert.deepEqual([again.done, again.total, again.missing], [1, 2, got.missing]);
  });
  await testCase(async () => { // cache only on the default source: no request at all, every tile missing
    let posts = 0;
    global.fetch = async () => { posts++; throw new Error("no network in a cache-only read"); };
    const s = new StreetIndex({ newFrac: () => 1 });
    const got = await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }], "run", { cacheOnly: true });
    assert.deepEqual([posts, got.done, got.total, got.missing.length], [0, 0, 2, 2]);
  });
  await testCase(async () => { // cache only: an expired copy (in the Map alone) is drawn from but not covered, so a download refreshes it
    const reads = [];
    const fetchStreets = async (tiles, kind, onTile, opts) => {
      reads.push({ n: tiles.length, cacheOnly: !!(opts && opts.cacheOnly) });
      const out = new Map();
      for (const t of tiles) {
        const answer = { ways: [way(t.x * 1000 + t.y)], groups: {} };
        if (opts && opts.cacheOnly) out.set(t.x + ":" + t.y, answer); else onTile(t, answer);
      }
      return out;
    };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets });
    const r = [{ s: 51.0, w: 13.7, n: 51.025, e: 13.725 }];
    const got = await s.ensureRects(r, "run", { cacheOnly: true });
    assert.deepEqual([got.done, got.total, got.missing, s.ways.length, s.tiles.size], [1, 1, [], 1, 0]);
    const v = s.version;
    const again = await s.ensureRects(r, "run", { cacheOnly: true });
    assert.deepEqual([again.done, again.total, s.version], [1, 1, v], "an expired copy already drawn from is not read again");
    await s.ensureRects(r, "run");
    assert.deepEqual(reads.map((x) => x.cacheOnly), [true, false], "a normal run asks for the expired tile");
    assert.equal(s.tiles.size, 1);
  });
  await testCase(async () => { // cache only: a source that throws is a bug, not a download, so it rejects as itself
    const bug = new TypeError("bug");
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async () => { throw bug; } });
    const err = await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }], "run", { cacheOnly: true }).then(() => null, (e) => e);
    assert.equal(err, bug);
  });
  await testCase(async () => { // what a caller passes on from a failed download: the reasons, counts and retry time, no text
    const cause = Object.assign(new Error("overpass: Query timed out at line 3"), { reason: "stalled", retryAt: 9 });
    assert.deepEqual(StreetIndex.downloadFacts(StreetIndex.downloadError(0, 4, cause)),
      { reason: "stalled", done: 0, total: 4, retryAt: 9, cause: { reason: "stalled" } });
    assert.deepEqual(StreetIndex.downloadFacts(new TypeError("x is undefined")),
      { reason: undefined, done: undefined, total: undefined, retryAt: undefined, cause: undefined });
    assert.deepEqual(StreetIndex.downloadFacts(undefined),
      { reason: undefined, done: undefined, total: undefined, retryAt: undefined, cause: undefined });
    assert.deepEqual([StreetIndex.downloadError(0, 4, cause), new TypeError("x"), undefined].map(StreetIndex.isDownloadError),
      [true, false, false], "only a download error is worded as one");
  });
  await testCase(async () => { // a run replaced while it sleeps through a busy wait rejects at the next look at stale(), not when the sleep ends
    const ticks = ticker();
    let stale = false;
    const fetchStreets = async (tiles, kind, onTile, opts) => { await opts.wait(opts.now() + 60000); return new Map(); };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets, now: () => 0, sleep: () => new Promise(() => {}), every: ticks.every });
    let err = null;
    const run = s.ensureRects(rect, "run", { stale: () => stale }).then(() => assert.fail("expected a rejection"), (e) => { err = e; return e; });
    await settle();
    ticks.fire();
    await settle();
    assert.equal(err, null, "not replaced: it sleeps on");
    stale = true;
    ticks.fire();
    assert.ok(StreetIndex.isSuperseded(await within(run)));
    assert.equal(ticks.live, 0, "the looks stop with the wait");
  });
  await testCase(async () => { // a run waiting only on another run's tile notices it was replaced, or its deadline, though that tile never lands
    for (const end of ["stale", "deadline"]) {
      const ticks = ticker(), clock = fakeClock();
      const one = [{ s: 51.0, w: 13.7, n: 51.02, e: 13.72 }];
      const s = new StreetIndex({ newFrac: () => 1, fetchStreets: () => new Promise(() => {}), now: clock.now, every: ticks.every });
      let stale = false, err = null;
      s.ensureRects(one, "run");
      const second = s.ensureRects(one, "run", { stale: () => stale, deadlineMs: 60000 }).then(() => assert.fail("expected a rejection"), (e) => { err = e; return e; });
      await settle();
      clock.t = 30000;
      ticks.fire();
      await settle();
      assert.equal(err, null, end + ": still waiting");
      if (end === "stale") stale = true; else clock.t = 60000;
      ticks.fire();
      const e = await within(second);
      assert.ok(StreetIndex.isDownloadError(e), end);
      assert.equal(e.cause.reason, end === "stale" ? "superseded" : "stalled", end);
      assert.equal(ticks.live, 0, end + ": the looks stop with the wait");
    }
  });
  await testCase(async () => { // a stale() that throws at a look while the run waits rejects as itself, a bug
    const ticks = ticker();
    const bug = new TypeError("stale() broke");
    let armed = false;
    const one = [{ s: 51.0, w: 13.7, n: 51.02, e: 13.72 }];
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: () => new Promise(() => {}), every: ticks.every });
    s.ensureRects(one, "run");
    const second = s.ensureRects(one, "run", { stale: () => { if (armed) throw bug; return false; } }).then(() => assert.fail("expected a rejection"), (e) => e);
    await settle();
    armed = true;
    ticks.fire();
    assert.equal(await within(second), bug);
  });
  await testCase(async () => { // _read needs the tile it reads: without one it throws rather than leave an expired way unreplaced
    const s = new StreetIndex({ newFrac: () => 1 });
    assert.throws(() => s._read({ ways: [], groups: {} }), TypeError);
  });
  await testCase(async () => { // the deadline is checked with >=: tiles landing every 25 s with a 75 s deadline stop at the third, one ms more asks a fourth
    const r = [{ s: 51.0, w: 13.7, n: 51.025, e: 13.825 }];
    for (const [deadlineMs, askedTiles] of [[75000, 3], [75001, 4]]) {
      const clock = { t: 0 };
      const src = slowSource(clock, 25000);
      const s = new StreetIndex({ newFrac: () => 1, fetchStreets: src.fetchStreets, now: () => clock.t });
      const err = await s.ensureRects(r, "run", { deadlineMs }).then(() => null, (e) => e);
      assert.deepEqual([src.asked.length, err.cause.reason], [askedTiles, "stalled"], "deadline " + deadlineMs);
    }
  });
  await testCase(async () => { // nearest first is measured from the centre of all rects together, not from the first rect
    const at = (x) => ({ s: 51.0, w: x * 0.025 + 0.001, n: 51.02, e: x * 0.025 + 0.01 });
    const order = [];
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles, kind, onTile) => {
      for (const t of tiles) { order.push(t.x); onTile(t, { ways: [], groups: {} }); }
      return new Map();
    } });
    await s.ensureRects([at(548), at(554), at(551)], "run");
    assert.equal(order[0], 551, "the middle tile is nearest the centre; the first rect's tile is not");
    assert.deepEqual(order.slice().sort(), [548, 551, 554]);
  });
  await testCase(async () => { // two runs at once over overlapping rects, with a source that both calls onTile and returns its Map: every tile is read
    // once, a way across tiles is held once, and (checked for every run in this file) no report goes above total or back down
    const shared = way(7);
    const gate = {};
    gate.p = new Promise((r) => { gate.open = r; });
    const asked = [];
    const fetchStreets = async (tiles, kind, onTile) => {
      asked.push(tiles.map((t) => t.x));
      await gate.p;
      const out = new Map();
      for (const t of tiles) { const a = { ways: [shared], groups: {} }; out.set(t.x + ":" + t.y, a); onTile(t, a); }
      return out;
    };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets });
    const row = (x0, x1) => [{ s: 51.0, w: x0 * 0.025 + 0.001, n: 51.02, e: x1 * 0.025 + 0.01 }];
    const a = s.ensureRects(row(548, 550), "run");
    const b = s.ensureRects(row(549, 551), "run");
    await settle();
    gate.open();
    assert.deepEqual(await within(Promise.all([a, b])), [{ done: 3, total: 3, missing: [] }, { done: 3, total: 3, missing: [] }]);
    assert.equal(asked.flat().length, 4, "each of the four tiles is asked once");
    assert.equal(s.tiles.size, 4);
    assert.equal(s.version, 4, "one version bump per tile read");
    const once = new StreetIndex({ newFrac: () => 1 });
    once._read({ ways: [shared], groups: {} }, { kind: "run", x: 548, y: 2040 });
    assert.equal(s.ways.length, 1, "the way is held once");
    assert.equal(s.segCount, once.segCount, "and its segments are counted once");
  });
  await testCase(async () => { // a 429 with a Retry-After while a third block waits for a slot: the waiting post is not sent into the hold, the
    // run waits the Retry-After out once none is open, and asks the blocks again
    const clock = fakeClock();
    global.Overpass._now = clock.now;
    const srv = { asked: [], pending: [] };
    global.fetch = (url, opts) => {
      const boxes = boxesOf(opts.body);
      srv.asked.push(boxes.join(" "));
      return new Promise((resolve) => srv.pending.push((status) => resolve(status
        ? { ok: false, status, headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "90" : null) }, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ elements: tileElements(boxes) }) })));
    };
    const reply = async (i, status) => { srv.pending.splice(i, 1)[0](status); await settle(); };
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const run = within(s.ensureRects(twelve, "run").then((r) => r, (e) => e));
    await settle();
    assert.equal(srv.asked.length, 2, "overpass-api.de takes two at once; the third block waits for a slot");
    await reply(0, 429);
    assert.equal(srv.asked.length, 2, "the waiting post gets the slot but the endpoint is held: not sent");
    assert.deepEqual(clock.sleeps, [], "the other request is still open, so no wait yet");
    await reply(0);
    assert.deepEqual(clock.sleeps, [90000], "the Retry-After, past the 15 s step");
    while (srv.pending.length) await reply(0);
    assert.deepEqual(await run, { done: 12, total: 12, missing: [] });
  });
  await testCase(async () => { // a later busy answer with a longer retry time raises the wait already set
    const clock = fakeClock();
    global.Overpass._now = clock.now;
    const srv = heldServer();
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const run = within(s.ensureRects(fiveTiles, "run").then((r) => r, (e) => e));
    await settle();
    await srv.reply(0, 502);
    assert.deepEqual(clock.sleeps, []);
    await srv.reply(0, 429);
    assert.deepEqual(clock.sleeps, [30000], "30 s, longer than the 15 s the first busy set");
    while (srv.pending.length) await srv.reply(0);
    assert.deepEqual(await run, { done: 5, total: 5, missing: [] });
  });
  await testCase(async () => { // after a fourth busy answer that comes with tiles, the count has restarted: the next busy waits 30 s, not
    // 15 again; and a 429 as that fourth busy stretches its wait to the hold
    for (const is429 of [false, true]) {
      const clock = fakeClock();
      global.Overpass._now = clock.now;
      const srv = heldServer();
      const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
      const run = within(s.ensureRects(fiveTiles, "run").then((r) => r, (e) => e));
      await settle();
      for (let step = 0; step < 3; step++) { await srv.reply(0, 502); await srv.reply(0, 502); }
      assert.deepEqual(clock.sleeps, [15000, 30000, 60000]);
      await srv.reply(0, is429 ? 429 : 502);
      await srv.reply(0);
      assert.equal(clock.sleeps.length, 4);
      assert.equal(clock.sleeps[3], is429 ? 30000 : 15000, "the fourth busy is the first step of a new count");
      assert.equal(srv.pending.length, 1);
      if (!is429) {
        await srv.reply(0, 502);
        assert.equal(clock.sleeps[4], 30000, "the next busy is the second step");
      }
      while (srv.pending.length) await srv.reply(0);
      const got = await run;
      assert.deepEqual([got.done, got.total], [5, 5]);
    }
  });
  await testCase(async () => { // a run past its deadline while two requests are open: the open ones finish and keep their tiles, nothing further is asked
    const clock = fakeClock();
    const srv = heldServer();
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const run = within(s.ensureRects(twelve, "run", { deadlineMs: 1000 }).then((r) => r, (e) => e));
    await settle();
    assert.equal(srv.pending.length, 2);
    clock.t = 5000;
    await srv.reply(0);
    await srv.reply(0);
    const err = await run;
    assert.equal(srv.asked.length, 2, "the third block is never asked");
    assert.equal(srv.pending.length, 0);
    assert.deepEqual([err.reason, err.cause.reason, err.done, err.total], ["streets-partial", "stalled", 8, 12], "both open requests' tiles are kept");
  });
  await testCase(async () => { // the run that owns a tile in flight fails offline: the run waiting for it is released and asks again
    const answer = { ways: [], groups: {} };
    const one = [{ s: 51.0, w: 13.7, n: 51.02, e: 13.72 }];
    const calls = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchStreets = async (tiles, kind, onTile) => {
      calls.push(tiles.length);
      if (calls.length === 1) { await gate; throw Object.assign(new Error("offline"), { reason: "offline" }); }
      tiles.forEach((t) => onTile(t, answer));
      return new Map();
    };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets });
    const first = s.ensureRects(one, "run").then(() => assert.fail("expected a rejection"), (e) => e);
    const second = s.ensureRects(one, "run");
    await settle();
    assert.deepEqual(calls, [1]);
    release();
    assert.equal((await within(first)).reason, "offline");
    assert.deepEqual(await within(second), { done: 1, total: 1, missing: [] });
    assert.deepEqual(calls, [1, 1], "asked again once the owner gave it up");
    assert.equal(s.inFlight.size, 0);
  });
  await testCase(async () => { // a cache-only read is never superseded, even with a stale() that is true
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async () => new Map() });
    const got = await s.ensureRects(rect, "run", { cacheOnly: true, stale: () => true });
    assert.deepEqual([got.done, got.total, got.missing.length], [0, 1, 1]);
  });
  await testCase(async () => { // a throw from onProgress during a busy wait that carries a street reason is still a bug: it rejects as itself
    const clock = fakeClock();
    tileServer((n) => n >= 2 && 502);
    const bug = Object.assign(new TypeError("bug"), { reason: "busy" });
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const err = await within(s.ensureRects(fiveTiles, "run", { onProgress: (p) => { if ("waitUntil" in p) throw bug; } }).then(() => null, (e) => e));
    assert.equal(err, bug);
    assert.equal(StreetIndex.isDownloadError(err), false);
  });
  await testCase(async () => { // the real chain: a run turned stale while a request is open, whose tile then fails to read, rejects as the bug, not superseded
    const bug = new TypeError("read broke");
    let stale = false;
    const asked = tileServer();
    const serve = global.fetch;
    global.fetch = async (url, opts) => { stale = true; return serve(url, opts); };
    const s = new StreetIndex({ newFrac: () => 1 });
    s._read = () => { throw bug; };
    const err = await within(s.ensureRects(rect, "run", { stale: () => stale }).then(() => null, (e) => e));
    assert.equal(err, bug);
    assert.equal(asked.length, 1);
  });
  await testCase(async () => { // only busy is waited out: a 406, a stall and a rejected fetch each stop the default source at its first request, no sleep, reason set
    const silent = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason)));
    const behaviours = {
      blocked: () => ({ ok: false, status: 406, json: async () => ({}) }),
      stalled: silent,
      offline: () => { throw new TypeError("Failed to fetch"); }
    };
    for (const [reason, behave] of Object.entries(behaviours)) {
      global.Overpass._reset();
      global.Overpass._firstByteMs = 5;
      let sentCount = 0;
      global.fetch = async (url, opts) => { sentCount++; return behave(url, opts); };
      const clock = fakeClock();
      const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
      const err = await within(s.ensureRects(rect, "run").then(() => null, (e) => e));
      assert.deepEqual([sentCount, clock.sleeps, err.cause.reason], [1, [], reason], reason);
    }
  });
  console.log("streets-fetch.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
