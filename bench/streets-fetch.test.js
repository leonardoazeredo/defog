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
// Answers each query with one way inside the bbox it asks for; fail(bbox) picks the queries that get a 502.
let nextWay = 100;
function tileServer(fail) {
  const asked = [];
  global.fetch = async (url, opts) => {
    const bbox = decodeURIComponent(opts.body).match(/\(([\d.,]+)\);/)[1];
    asked.push(bbox);
    if (fail && fail(bbox)) return { ok: false, status: 502, json: async () => ({}) };
    const [s, w] = bbox.split(",").map(Number), id = nextWay++;
    return { ok: true, status: 200, json: async () => ({ elements: [{ type: "way", id, nodes: [id * 10, id * 10 + 1], geometry: [{ lat: s + 0.001, lon: w + 0.001 }, { lat: s + 0.002, lon: w + 0.001 }] }] }) };
  };
  return asked;
}
const box = (x, y) => { const b = StreetIndex.tileBounds({ x, y }); return [b.s, b.w, b.n, b.e].map((v) => v.toFixed(4)).join(","); };
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
  { // a rect over two tiles asks for each in its own query, a highway and a service clause with the tile's bbox
    const bodies = [];
    global.fetch = async (url, opts) => { bodies.push(decodeURIComponent(opts.body)); return { ok: true, status: 200, json: async () => ({ elements: [] }) }; };
    const s = new StreetIndex({ newFrac: () => 1 });
    await s.ensureRects([{ s: 51.01, w: 13.74, n: 51.02, e: 13.76 }], "run");
    assert.equal(bodies.length, 2, "one query per tile");
    const tilesOf = bodies.map((b) => [...b.matchAll(/\(([\d.,]+)\);/g)].map((m) => m[1]));
    for (const t of tilesOf) assert.equal(new Set(t).size, 1, "a query holds one tile's bbox");
    assert.deepEqual(tilesOf.map((t) => [t.length, t[0]]).sort(), [[2, "51.0000,13.7250,51.0250,13.7500"], [2, "51.0000,13.7500,51.0250,13.7750"]]);
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
    assert.ok(StreetIndex.rectQuery(boxes, "run").startsWith("[out:json][timeout:25];"), "the server gives up before the client's 30 s");
    const sha = (kind) => crypto.createHash("sha1").update(StreetIndex.rectQuery(boxes, kind)).digest("hex");
    assert.equal(sha("run"), "822a328d1c8f332ec55d2e363755ba4075c475f2");
    assert.equal(sha("bike"), "e3620d77390907388c5540fba2593f2325f19077");
    assert.equal(sha("car"), "33f830337ebdd0c1c3afee063d36004a9aa1c03a");
    replyWith({ elements: [] });
    await StreetIndex.overpassFetch([{ x: 548, y: 2040 }], "run");
    assert.equal(sent, "data=" + StreetIndex.rectQuery([StreetIndex.tileBounds({ x: 548, y: 2040 })], "run"), "the default source asks for the tile's bounds");
  }
  { // four uncovered tiles are four requests, the one nearest the centre of the rects first
    // centre 51.03, 13.73 lies in tile 549:2041; west of it is nearer than south of it once longitude is scaled by cos(lat)
    global.Overpass._reset();
    const asked = tileServer();
    const s = new StreetIndex({ newFrac: () => 1 });
    await s.ensureRects([{ s: 51.02, w: 13.72, n: 51.04, e: 13.74 }], "run");
    assert.deepEqual(asked, [box(549, 2041), box(548, 2041), box(549, 2040), box(548, 2040)]);
    assert.equal(s.ways.length, 4);
  }
  { // the third of four requests fails: the first two tiles are kept, and the retry asks only the other two
    global.Overpass._reset();
    let failing = true;
    const asked = tileServer((bbox) => failing && bbox === box(549, 2040));
    const s = new StreetIndex({ newFrac: () => 1 });
    const r = [{ s: 51.02, w: 13.72, n: 51.04, e: 13.74 }];
    const err = await s.ensureRects(r, "run").then(() => null, (e) => e);
    assert.ok(err, "a run with a tile missing rejects");
    assert.deepEqual([err.done, err.total, err.reason], [2, 4, "streets-partial"]);
    assert.equal(err.cause.reason, "busy", "the Overpass error is the cause");
    assert.equal(asked.filter((b) => b === box(548, 2040)).length, 0, "the run stops at the failed request");
    assert.deepEqual([s.covered(51.03, 13.73), s.covered(51.03, 13.72), s.covered(51.02, 13.73)], [true, true, false]);
    failing = false;
    asked.length = 0;
    await s.ensureRects(r, "run");
    assert.deepEqual(asked, [box(549, 2040), box(548, 2040)]);
    assert.equal(s.ways.length, 4);
  }
  { // the default source stops at its first failed request; nothing arrived, so the error carries the cause's reason
    global.Overpass._reset();
    const asked = tileServer(() => true);
    const err = await StreetIndex.overpassFetch([{ x: 548, y: 2040 }, { x: 549, y: 2040 }], "run").then(() => null, (e) => e);
    assert.equal(asked.length, 2, "one request, tried on both endpoints");
    assert.deepEqual([err.done, err.total, err.reason, err.cause.reason], [0, 2, "busy", "busy"]);
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
    const src = slowSource(clock, 30000);
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: src.fetchStreets, now: () => clock.t });
    const progress = [];
    const r = [{ s: 51.0, w: 13.7, n: 51.025, e: 13.825 }]; // five tiles in a row
    const err = await s.ensureRects(r, "run", { onProgress: (p) => progress.push(p) }).then(() => null, (e) => e);
    assert.equal(src.asked.length, 3, "past 75 s at the third tile (90 s): no fourth request");
    assert.deepEqual([err.done, err.total, err.reason, err.cause.reason], [3, 5, "streets-partial", "stalled"]);
    assert.deepEqual(progress, [0, 1, 2, 3].map((done) => ({ done, total: 5 })));
    const t = new StreetIndex({ newFrac: () => 1, fetchStreets: slowSource(clock, 30000).fetchStreets, now: () => clock.t });
    const err2 = await t.ensureRects(r, "run", { deadlineMs: 20000 }).then(() => null, (e) => e);
    assert.deepEqual([err2.done, err2.total], [1, 5], "opts.deadlineMs sets the deadline");
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
