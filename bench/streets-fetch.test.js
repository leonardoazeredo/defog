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
    await assert.rejects(() => s.ensureRects(rect, "run"), /timed out/);
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
    assert.equal(s.needsFetch(rect, "bike"), false);
    assert.equal(s.needsFetch(rect, "car"), true);
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
  { // a rect over two tiles asks for both in one call, one bbox clause per tile
    replyWith({ elements: [] });
    const s = new StreetIndex({ newFrac: () => 1 });
    await s.ensureRects([{ s: 51.01, w: 13.74, n: 51.02, e: 13.76 }], "run");
    assert.equal(sent.split("(51.0000,13.7000,51.0500,13.7500)").length - 1, 2, "tile 274 has a highway and a service clause");
    assert.equal(sent.split("(51.0000,13.7500,51.0500,13.8000)").length - 1, 2, "tile 275 has a highway and a service clause");
    assert.equal(sent.split("[out:json]").length - 1, 1, "one query");
    assert.equal(s.covered(51.01, 13.76), true);
  }
  { // tiles are the 0.05° grid; an east or north bound on a tile edge does not pull in the next tile, but a rect with no width there still finds its tile
    assert.deepEqual(StreetIndex.tileOf(13.72, 51.03), { x: 274, y: 1020 });
    assert.deepEqual(StreetIndex.tilesCovering({ s: 51.0, w: 13.7, n: 51.05, e: 13.75 }), [{ x: 274, y: 1020 }]);
    assert.deepEqual(StreetIndex.tilesCovering({ s: 51.03, w: 13.75, n: 51.03, e: 13.75 }), [{ x: 275, y: 1020 }]);
    assert.deepEqual(StreetIndex.tilesCovering({ s: 51.05, w: 13.72, n: 51.05, e: 13.73 }), [{ x: 274, y: 1021 }], "no height on a south edge");
    assert.deepEqual(StreetIndex.tilesCovering({ s: -0.03, w: -0.05, n: -0.02, e: -0.05 }), [{ x: -1, y: -1 }], "negative coordinates, no width on a west edge");
    assert.deepEqual(StreetIndex.tilesCovering({ s: 51.03, w: 13.7, n: 51.04, e: 13.8 }), [{ x: 274, y: 1020 }, { x: 275, y: 1020 }]);
    for (const x of [1, 7, 274, 275, -3]) for (const y of [3, 6, 1020, -7]) {
      assert.deepEqual(StreetIndex.tilesCovering(StreetIndex.tileBounds({ x, y })), [{ x, y }], `tile ${x},${y} maps back to itself`);
    }
    assert.equal(StreetIndex.tileKey("bike", 274, 1020), "bike:274:1020");
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
    assert.deepEqual(asked, [["274:1020"], ["275:1020", "276:1020", "277:1020"]]);
  }
  { // a source that answers some tiles and leaves one out changes nothing: no ways, no version bump, no coverage
    const full = { ways: [{ id: 1, nodes: [1, 2], geometry: [{ lat: 51.01, lon: 13.71 }, { lat: 51.011, lon: 13.71 }] }], groups: {} };
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async () => new Map([["274:1020", full]]) });
    await assert.rejects(() => s.ensureRects([{ s: 51.01, w: 13.74, n: 51.02, e: 13.76 }], "run"), /no answer for tile 275:1020 \(run\)/);
    assert.deepEqual([s.ways.length, s.wayIds.size, s.classified.size, s.tiles.size, s.version], [0, 0, 0, 0, 0]);
  }
  { // a source that leaves a requested tile out is an error, and nothing is recorded as fetched
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async () => new Map() });
    await assert.rejects(() => s.ensureRects(rect, "run"), /no answer/);
    assert.equal(s.tiles.size, 0);
    assert.equal(s.version, 0);
  }
  { // the default source splits one answer per tile: a way over a tile edge lands in both tiles, ids filtered per tile
    const wide = { type: "way", id: 7, nodes: [70, 71], geometry: [{ lat: 51.01, lon: 13.74 }, { lat: 51.01, lon: 13.76 }] };
    const west = { type: "way", id: 8, nodes: [80, 81], geometry: [{ lat: 51.02, lon: 13.71 }, { lat: 51.02, lon: 13.72 }] };
    const lost = { type: "way", id: 9, nodes: [90, 91], geometry: [{ lat: 51.3, lon: 13.0 }, { lat: 51.3, lon: 13.01 }] };
    // geometry, then bike, road, car, oneWay, reverseWay, bikeBoth, motorway
    replyWith({ elements: [wide, west, lost, count, ...ids(7, 8), count, ...ids(7), count, count, ...ids(8, 9), count, count, count] });
    const tiles = [{ x: 274, y: 1020 }, { x: 275, y: 1020 }];
    const out = await StreetIndex.overpassFetch(tiles, "bike");
    assert.deepEqual([...out.keys()], ["274:1020", "275:1020"]);
    assert.deepEqual(out.get("274:1020").ways.map((w) => w.id), [7, 8, 9], "7 straddles, 8 is inside, 9 matches no tile and goes to the first");
    assert.deepEqual(out.get("275:1020").ways.map((w) => w.id), [7]);
    assert.deepEqual(out.get("274:1020").groups.bike, [7, 8]);
    assert.deepEqual(out.get("275:1020").groups.bike, [7]);
    assert.deepEqual(out.get("274:1020").groups.road, [7]);
    assert.deepEqual(out.get("275:1020").groups.road, [7], "the straddling way carries its ids into both tiles");
    assert.deepEqual(out.get("274:1020").groups.oneWay, [8, 9]);
    assert.deepEqual(out.get("275:1020").groups.oneWay, []);
    assert.deepEqual(Object.keys(out.get("275:1020").groups), ["bike", "road", "car", "oneWay", "reverseWay", "bikeBoth", "motorway"]);
    assert.equal(structuredClone(out.get("274:1020")).ways.length, 3, "an answer is structured-clone friendly");
    // the index takes the straddling way once
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: async () => out });
    await s.ensureRects([{ s: 51.0, w: 13.7, n: 51.05, e: 13.8 }], "bike");
    assert.deepEqual(s.ways.map((w) => w.id), [7, 8, 9]);
    assert.equal(s.version, 1, "one version bump per fetch");
  }
  { // pins the query text the bench cache is keyed on; a changed hash means every saved answer misses
    const boxes = [{ s: 51, w: 13.7, n: 51.01, e: 13.71 }, { s: 51.2, w: 13.8, n: 51.21, e: 13.9 }];
    const sha = (kind) => crypto.createHash("sha1").update(StreetIndex.rectQuery(boxes, kind)).digest("hex");
    assert.equal(sha("run"), "e949360a8672947cd547397c201b74b9d1b6980e");
    assert.equal(sha("bike"), "e224471687db756785bbbbdf48a0dc380640bf92");
    assert.equal(sha("car"), "767226bcf1f28f1e3dad58826efd2d04be67bedd");
    replyWith({ elements: [] });
    await StreetIndex.overpassFetch([{ x: 274, y: 1020 }], "run", boxes);
    assert.equal(sent, "data=" + StreetIndex.rectQuery(boxes, "run"), "explicit boxes replace the tiles' bounds in the query");
  }
  console.log("streets-fetch.test.js ok");
})();
