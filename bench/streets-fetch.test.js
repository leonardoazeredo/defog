// StreetIndex.ensureRects: which lists the Overpass query asks for and how the reply is read; fake fetch, no network.
//   node bench/streets-fetch.test.js
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { StreetIndex } = require("./lib/load.js");

const way = (id) => ({ type: "way", id, nodes: [id * 10, id * 10 + 1], geometry: [{ lat: 51, lon: 13.7 }, { lat: 51.001, lon: 13.7 }] });
const ids = (...xs) => xs.map((id) => ({ type: "way", id }));
const count = { type: "count" };
let sent = null;
function replyWith(body) {
  global.fetch = async (url, opts) => { sent = decodeURIComponent(opts.body); return { ok: true, status: 200, json: async () => body }; };
}
const rect = [{ s: 51, w: 13.7, n: 51.01, e: 13.71 }];
// Answers each query with one way in every tile of every bbox it asks for, and records the query's
// bboxes, space-separated; fail(n, bboxes) gives the HTTP status for the n-th query (from 1), nothing
// for a 200.
let nextWay = 100;
function tileServer(fail) {
  const asked = [];
  global.fetch = async (url, opts) => {
    const boxes = [...new Set([...decodeURIComponent(opts.body).matchAll(/\(([\d.,]+)\);/g)].map((m) => m[1]))];
    asked.push(boxes.join(" "));
    const status = fail && fail(asked.length, asked[asked.length - 1]);
    if (status) return { ok: false, status, json: async () => ({}) };
    const elements = [];
    for (const b of boxes) {
      const [s, w, n, e] = b.split(",").map(Number);
      for (const t of StreetIndex.tilesCovering({ s, w, n, e })) {
        const id = nextWay++, tb = StreetIndex.tileBounds(t);
        elements.push({ type: "way", id, nodes: [id * 10, id * 10 + 1], geometry: [{ lat: tb.s + 0.001, lon: tb.w + 0.001 }, { lat: tb.s + 0.002, lon: tb.w + 0.001 }] });
      }
    }
    return { ok: true, status: 200, json: async () => ({ elements }) };
  };
  return asked;
}
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
// five tiles: the 2x2 block 548..549 x 2040..2041, nearest the centre, then 550:2040
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

(async () => {
  { // a wheeled (bike-kind) fetch asks for the travel classes too, so car and road profiles are filtered
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
    assert.equal(s.usableFor("car-fast")(1), false, "way 1 is not a car way");
    assert.ok(sent.indexOf(".bike") < sent.indexOf(".oneWay"), "class lists come before the one-way lists");
  }
  { // an Overpass answer that ran out of time or memory is a failed fetch, not an empty area
    replyWith({ elements: [way(1)], remark: "runtime error: Query timed out in \"query\" at line 3 after 61 seconds." });
    const s = new StreetIndex({ newFrac: () => 1 });
    const err = await s.ensureRects(rect, "run").then(() => null, (e) => e);
    assert.match(err.message, /timed out/);
    assert.equal(err.reason, "server", "a remark is the server's failure, so the page can word it");
    assert.equal(s.tiles.size, 0, "the area is not recorded as fetched");
  }
  { // the box is scanned once; every list is filtered from that result (rescanning per list timed out Overpass)
    replyWith({ elements: [] });
    await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "run");
    assert.equal(sent.split("51.0000,13.7000").length - 1, 2, "one highway clause and one service clause");
    assert.match(sent, /->\.all;/);
  }
  { // bikes are kept off bicycle=no, cars are not; a car fetch also takes motorways
    replyWith({ elements: [] });
    await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "car");
    assert.match(sent, /motorway\|motorway_link/);
    assert.doesNotMatch(sent, /motorroad/);
    assert.match(sent, /\.bike;|->\.bike/);
    const bikeList = sent.slice(sent.indexOf("("), sent.length).split("->.bike")[0];
    assert.match(bikeList.slice(bikeList.lastIndexOf("(")), /\[bicycle!=no\]/);
    const carList = sent.split("->.road;")[1].split("->.car;")[0];
    assert.doesNotMatch(carList, /bicycle/);
  }
  { // a walking fetch does not cover a request for cars (no motorways in it)
    const s = new StreetIndex({ newFrac: () => 1 });
    s._cover(StreetIndex.tilesCovering({ s: 50, w: 13, n: 52, e: 14 }), "run");
    assert.equal(s._uncovered(rect, "bike").length, 0);
    assert.ok(s._uncovered(rect, "car").length > 0);
  }
  { // walking and wheels both exclude motorroads; walking also foot=no
    replyWith({ elements: [] });
    await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "run");
    assert.match(sent, /\[motorroad!=yes\]\[foot!=no\]/);
    await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "bike");
    assert.match(sent, /\[motorroad!=yes\]/);
    assert.doesNotMatch(sent, /foot!=no/);
  }
  { // a rect inside tiles that are already fetched makes no call
    let calls = 0;
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles) => { calls++; return new Map(tiles.map((t) => [t.x + ":" + t.y, { ways: [], groups: {} }])); } });
    await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.1, e: 13.8 }], "run");
    assert.equal(calls, 1);
    await s.ensureRects([{ s: 51.02, w: 13.72, n: 51.03, e: 13.73 }], "run");
    await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.1, e: 13.8 }], "run");
    assert.equal(calls, 1, "a rect inside fetched tiles, and the same rect again, fetch nothing");
    assert.equal(s.covered(51.09, 13.79), true);
    assert.equal(s.covered(51.11, 13.79), false, "the tile north of the fetch is not covered");
  }
  { // a rect over two tiles side by side is one query over the box they fill, a highway and a service clause
    const bodies = [];
    global.fetch = async (url, opts) => { bodies.push(decodeURIComponent(opts.body)); return { ok: true, status: 200, json: async () => ({ elements: [] }) }; };
    const s = new StreetIndex({ newFrac: () => 1 });
    await s.ensureRects([{ s: 51.01, w: 13.74, n: 51.02, e: 13.76 }], "run");
    assert.equal(bodies.length, 1, "one query for both tiles");
    assert.deepEqual([...bodies[0].matchAll(/\(([\d.,]+)\);/g)].map((m) => m[1]), ["51.0000,13.7250,51.0250,13.7750", "51.0000,13.7250,51.0250,13.7750"]);
    assert.equal(s.covered(51.01, 13.74), true);
    assert.equal(s.covered(51.01, 13.76), true);
  }
  { // tiles are the 0.025° grid; an east or north bound on a tile edge does not pull in the next tile, but a rect with no width there still finds its tile
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
  }
  { // a bike request after a run fetch makes no call; a car request does
    let kinds = [];
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles, kind) => { kinds.push(kind); return new Map(tiles.map((t) => [t.x + ":" + t.y, { ways: [], groups: {} }])); } });
    await s.ensureRects(rect, "run");
    await s.ensureRects(rect, "bike");
    assert.deepEqual(kinds, ["run"]);
    await s.ensureRects(rect, "car");
    assert.deepEqual(kinds, ["run", "car"]);
    await s.ensureRects(rect, "car");
    assert.deepEqual(kinds, ["run", "car"], "the car fetch is remembered next to the run fetch");
  }
  { // a rect over one fetched and one new tile asks only for the new one; overlapping rects ask for each tile once
    const asked = [];
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles) => { asked.push(tiles.map((t) => t.x + ":" + t.y)); return new Map(tiles.map((t) => [t.x + ":" + t.y, { ways: [], groups: {} }])); } });
    await s.ensureRects([{ s: 51.01, w: 13.71, n: 51.02, e: 13.72 }], "run");
    await s.ensureRects([{ s: 51.01, w: 13.71, n: 51.02, e: 13.78 }, { s: 51.01, w: 13.76, n: 51.02, e: 13.89 }], "run");
    assert.deepEqual(asked[0], ["548:2040"]);
    assert.deepEqual(asked[1].slice().sort(), ["549:2040", "550:2040", "551:2040", "552:2040", "553:2040", "554:2040", "555:2040"]);
  }
  { // a source that answers some tiles and leaves one out: the answered tile is kept, the call says what is missing
    const full = { ways: [{ id: 1, nodes: [1, 2], geometry: [{ lat: 51.01, lon: 13.74 }, { lat: 51.011, lon: 13.74 }] }], groups: {} };
    const asked = [];
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async (tiles) => { asked.push(tiles.map((t) => t.x + ":" + t.y)); return new Map([["549:2040", full]]); } });
    const err = await s.ensureRects([{ s: 51.01, w: 13.74, n: 51.02, e: 13.76 }], "run").then(() => null, (e) => e);
    assert.match(err.message, /no answer for tile 550:2040 \(run\)/);
    assert.deepEqual([err.done, err.total, err.reason], [1, 2, "streets-partial"]);
    assert.deepEqual([s.ways.length, s.tiles.size, s.version], [1, 1, 1]);
    await s.ensureRects([{ s: 51.01, w: 13.74, n: 51.02, e: 13.76 }], "run").catch(() => {});
    assert.deepEqual(asked[1], ["550:2040"], "the retry asks only the missing tile");
  }
  { // a source that leaves a requested tile out is an error, and nothing is recorded as fetched
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async () => new Map() });
    const err = await s.ensureRects(rect, "run").then(() => null, (e) => e);
    assert.match(err.message, /no answer/);
    assert.equal(err.reason, "server", "a tile left out is the source's failure, so the page can word it");
    assert.equal(s.tiles.size, 0);
    assert.equal(s.version, 0);
  }
  { // an answer over several tiles is split per tile: a way over a tile edge lands in both tiles, ids filtered per tile
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
  }
  { // pins the query text the bench cache is keyed on. The hash covers the timeout header too, but the
    // bench cache ignores it: a hash change from anything else means every saved answer misses
    const boxes = [{ s: 51, w: 13.7, n: 51.01, e: 13.71 }, { s: 51.2, w: 13.8, n: 51.21, e: 13.9 }];
    assert.ok(StreetIndex.rectQuery(boxes, "run").startsWith("[out:json][timeout:25];"), "the server's run is capped at 25 s, under the client's guards");
    const sha = (kind) => crypto.createHash("sha1").update(StreetIndex.rectQuery(boxes, kind)).digest("hex");
    assert.equal(sha("run"), "822a328d1c8f332ec55d2e363755ba4075c475f2");
    assert.equal(sha("bike"), "e3620d77390907388c5540fba2593f2325f19077");
    assert.equal(sha("car"), "33f830337ebdd0c1c3afee063d36004a9aa1c03a");
    replyWith({ elements: [] });
    await StreetIndex.overpassFetch([{ x: 548, y: 2040 }], "run");
    assert.equal(sent, "data=" + StreetIndex.rectQuery([StreetIndex.tileBounds({ x: 548, y: 2040 })], "run"), "the default source asks for the tile's bounds");
  }
  { // four uncovered tiles of one 2x2 block are one request over the block's box, split back per tile
    global.Overpass._reset();
    const asked = tileServer();
    const s = new StreetIndex({ newFrac: () => 1 });
    const progress = [];
    await s.ensureRects([{ s: 51.02, w: 13.72, n: 51.04, e: 13.74 }], "run", { onProgress: (p) => progress.push(p.done) });
    assert.deepEqual(asked, [span(548, 2040, 549, 2041)]);
    assert.deepEqual([s.ways.length, s.tiles.size, progress], [4, 4, [0, 1, 2, 3, 4]]);
  }
  { // eight missing tiles are two requests, one per 2x2 block, nearest block first, each tile handed over on its own
    global.Overpass._reset();
    const asked = tileServer();
    const got = [];
    const tiles = [T(549, 2040), T(550, 2040), T(549, 2041), T(550, 2041), T(548, 2040), T(551, 2040), T(548, 2041), T(551, 2041)];
    const out = await StreetIndex.overpassFetch(tiles, "run", (t, answer) => got.push([t.x + ":" + t.y, answer.ways.length]));
    assert.deepEqual(asked, [span(548, 2040, 549, 2041), span(550, 2040, 551, 2041)]);
    assert.deepEqual(got, [["549:2040", 1], ["549:2041", 1], ["548:2040", 1], ["548:2041", 1], ["550:2040", 1], ["550:2041", 1], ["551:2040", 1], ["551:2041", 1]]);
    assert.equal(out.size, 8);
  }
  { // a batch takes the nearest tile's 2x2 block mates first, fills up to four with the next nearest,
    // and asks tiles that do not fill a rectangle as a box each
    global.Overpass._reset();
    const asked = tileServer();
    await StreetIndex.overpassFetch([T(548, 2040), T(550, 2040), T(549, 2040), T(552, 2040), T(549, 2041), T(548, 2041), T(551, 2040)], "run");
    assert.deepEqual(asked, [span(548, 2040, 549, 2041), span(550, 2040, 552, 2040)]);
    asked.length = 0;
    await StreetIndex.overpassFetch([T(548, 2040), T(551, 2041)], "run");
    assert.deepEqual(asked, [box(548, 2040) + " " + box(551, 2041)]);
  }
  { // the second of two requests fails: the first block's tiles are kept, and the retry asks only the other block
    global.Overpass._reset();
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
  }
  { // the default source stops at its first failed request that is not busy; nothing arrived, so the error carries the cause's reason
    global.Overpass._reset();
    const asked = tileServer(() => 500);
    const tiles = [T(548, 2040), T(549, 2040), T(548, 2041), T(549, 2041), T(550, 2040)];
    const err = await StreetIndex.overpassFetch(tiles, "run").then(() => null, (e) => e);
    assert.equal(asked.length, 1, "one request on the one endpoint there is without a key, none for the next batch");
    assert.deepEqual([err.done, err.total, err.reason, err.cause.reason], [0, 5, "server", "server"]);
  }
  { // busy is asked again after 15, 30 and 60 s, each wait in the progress; the fourth busy in a row ends the run
    global.Overpass._reset();
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
  }
  { // an answer between busy ones starts the count again: three busy before each of two requests still completes
    global.Overpass._reset();
    const clock = fakeClock();
    const asked = tileServer((n) => n % 4 !== 0 && 502);
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const got = await s.ensureRects(fiveTiles, "run");
    assert.deepEqual([got.done, got.total, asked.length], [5, 5, 8]);
    assert.deepEqual(clock.sleeps, [15000, 30000, 60000, 15000, 30000, 60000]);
  }
  { // a busy with a later retry time waits until then
    global.Overpass._reset();
    const clock = fakeClock();
    global.Overpass._now = clock.now;
    let posts = 0;
    global.fetch = async () => {
      posts++;
      if (posts === 1) return { ok: false, status: 429, headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "100" : null) }, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ elements: [] }) };
    };
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const progress = [];
    await s.ensureRects(rect, "run", { onProgress: (p) => progress.push(p) });
    assert.deepEqual([posts, clock.sleeps], [2, [100000]]);
    assert.deepEqual(progress[1], { done: 0, total: 1, waitUntil: 100000 });
    global.Overpass._reset();
  }
  { // a wait that would end past the run deadline is not waited: the run ends there, busy
    global.Overpass._reset();
    const clock = fakeClock();
    const asked = tileServer(() => 502);
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: clock.sleep });
    const err = await s.ensureRects(rect, "run", { deadlineMs: 40000 }).then(() => null, (e) => e);
    assert.deepEqual([asked.length, clock.sleeps], [2, [15000]], "15 s fits in 40 s, 15 + 30 s does not");
    assert.deepEqual([err.done, err.total, err.reason], [0, 1, "busy"]);
  }
  { // a run superseded while it waits out a busy server asks nothing further
    global.Overpass._reset();
    const clock = fakeClock();
    const asked = tileServer((n) => n >= 2 && 502);
    let stale = false;
    const s = new StreetIndex({ newFrac: () => 1, now: clock.now, sleep: async (ms) => { await clock.sleep(ms); stale = true; } });
    const err = await s.ensureRects(fiveTiles, "run", { stale: () => stale }).then(() => null, (e) => e);
    assert.equal(asked.length, 2, "no request after the wait");
    assert.ok(StreetIndex.isDownloadError(err));
    assert.equal(err.cause.reason, "superseded");
  }
  { // a run superseded once a request has answered asks for no further batch; one already stale asks nothing
    global.Overpass._reset();
    const asked = tileServer();
    let stale = false;
    const s = new StreetIndex({ newFrac: () => 1 });
    const err = await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.05, e: 13.79 }], "run", { stale: () => stale, onProgress: (p) => { if (p.done === 4) stale = true; } }).then(() => null, (e) => e);
    assert.equal(asked.length, 1);
    assert.deepEqual([err.done, err.total, err.cause.reason], [4, 8, "superseded"]);
    asked.length = 0;
    const err2 = await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "run", { stale: () => true }).then(() => null, (e) => e);
    assert.deepEqual([asked.length, err2.cause.reason], [0, "superseded"]);
  }
  { // a throw from onTile that is not the caller's stop (a bug) comes out of the default source unchanged
    global.Overpass._reset();
    tileServer();
    const bug = new TypeError("bug");
    const err = await StreetIndex.overpassFetch([{ x: 548, y: 2040 }, { x: 549, y: 2040 }], "run", () => { throw bug; }).then(() => null, (e) => e);
    assert.equal(err, bug);
  }
  { // a bug thrown while reading a tile comes out of ensureRects as itself, not as a download error
    global.Overpass._reset();
    tileServer();
    const s = new StreetIndex({ newFrac: () => 1 });
    s._read = () => { throw new TypeError("bug"); };
    const err = await s.ensureRects(rect, "run").then(() => null, (e) => e);
    assert.ok(err instanceof TypeError);
    assert.equal(err.total, undefined);
  }
  { // the cause's retryAt is copied onto the error, and its reason when no tile arrived
    const cause = Object.assign(new Error("overpass HTTP 429"), { reason: "busy", retryAt: 12345 });
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async () => { throw cause; } });
    const err = await s.ensureRects(rect, "run").then(() => null, (e) => e);
    assert.deepEqual([err.done, err.total, err.reason, err.retryAt, err.cause], [0, 1, "busy", 12345, cause]);
  }
  { // a run past its deadline stops before the next request, with its progress
    const clock = { t: 0 };
    const src = slowSource(clock, 500000);
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: src.fetchStreets, now: () => clock.t });
    const progress = [];
    const r = [{ s: 51.0, w: 13.7, n: 51.025, e: 13.825 }]; // five tiles in a row
    const err = await s.ensureRects(r, "run", { onProgress: (p) => progress.push(p) }).then(() => null, (e) => e);
    assert.equal(src.asked.length, 3, "past 20 min at the third tile (25 min): no fourth request");
    assert.deepEqual([err.done, err.total, err.reason, err.cause.reason], [3, 5, "streets-partial", "stalled"]);
    assert.deepEqual(progress, [0, 1, 2, 3].map((done) => ({ done, total: 5 })));
    const t = new StreetIndex({ newFrac: () => 1, fetchStreets: slowSource(clock, 30000).fetchStreets, now: () => clock.t });
    const err2 = await t.ensureRects(r, "run", { deadlineMs: 20000 }).then(() => null, (e) => e);
    assert.deepEqual([err2.done, err2.total], [1, 5], "opts.deadlineMs sets the deadline");
  }
  { // a request answered past the deadline keeps every tile it brought, then asks nothing further
    const clock = { t: 0 };
    const asked = tileServer();
    const serve = global.fetch;
    global.fetch = async (url, opts) => { clock.t += 1300000; return serve(url, opts); }; // past 20 min
    const s = new StreetIndex({ newFrac: () => 1, now: () => clock.t });
    const err = await s.ensureRects(fiveTiles, "run").then(() => null, (e) => e);
    assert.equal(asked.length, 1);
    assert.deepEqual([err.done, err.total, err.reason, err.cause.reason], [4, 5, "streets-partial", "stalled"]);
  }
  { // the last tile is kept even when it lands past the deadline: the check runs only while tiles remain
    const clock = { t: 0 };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: slowSource(clock, 30000).fetchStreets, now: () => clock.t });
    await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }], "run", { deadlineMs: 45000 });
    assert.equal(s.tiles.size, 2);
  }
  { // a second run over ground the first one covered asks nothing and reports no progress
    const clock = { t: 0 };
    const src = slowSource(clock, 1000);
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: src.fetchStreets, now: () => clock.t });
    const r = [{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }];
    const first = [], second = [];
    await s.ensureRects(r, "run", { onProgress: (p) => first.push(p) });
    await s.ensureRects(r, "run", { onProgress: (p) => second.push(p) });
    assert.deepEqual(first, [0, 1, 2].map((done) => ({ done, total: 2 })));
    assert.deepEqual([second, src.asked.length], [[], 2], "a covered area is not shown as a download");
  }
  { // cache only: what the source holds is merged, the rest is listed as missing instead of rejected
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
    assert.deepEqual([again.done, again.total, again.missing], [0, 1, got.missing]);
  }
  { // cache only on the default source: no request at all, every tile missing
    let posts = 0;
    global.fetch = async () => { posts++; throw new Error("no network in a cache-only read"); };
    const s = new StreetIndex({ newFrac: () => 1 });
    const got = await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }], "run", { cacheOnly: true });
    assert.deepEqual([posts, got.done, got.total, got.missing.length], [0, 0, 2, 2]);
  }
  { // cache only: an expired copy (in the Map alone) is drawn from but not covered, so a download refreshes it
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
    assert.deepEqual([again.total, s.version], [0, v], "an expired copy already drawn from is not read again");
    await s.ensureRects(r, "run");
    assert.deepEqual(reads.map((x) => x.cacheOnly), [true, false], "a normal run asks for the expired tile");
    assert.equal(s.tiles.size, 1);
  }
  { // cache only: a source that throws is a bug, not a download, so it rejects as itself
    const bug = new TypeError("bug");
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async () => { throw bug; } });
    const err = await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.025, e: 13.75 }], "run", { cacheOnly: true }).then(() => null, (e) => e);
    assert.equal(err, bug);
  }
  { // what a caller passes on from a failed download: the reasons, counts and retry time, no text
    const cause = Object.assign(new Error("overpass: Query timed out at line 3"), { reason: "stalled", retryAt: 9 });
    assert.deepEqual(StreetIndex.downloadFacts(StreetIndex.downloadError(0, 4, cause)),
      { reason: "stalled", done: 0, total: 4, retryAt: 9, cause: { reason: "stalled" } });
    assert.deepEqual(StreetIndex.downloadFacts(new TypeError("x is undefined")),
      { reason: undefined, done: undefined, total: undefined, retryAt: undefined, cause: undefined });
    assert.deepEqual(StreetIndex.downloadFacts(undefined),
      { reason: undefined, done: undefined, total: undefined, retryAt: undefined, cause: undefined });
    assert.deepEqual([StreetIndex.downloadError(0, 4, cause), new TypeError("x"), undefined].map(StreetIndex.isDownloadError),
      [true, false, false], "only a download error is worded as one");
  }
  console.log("streets-fetch.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
