// StreetIndex.ensureRects: which lists the Overpass query asks for and how the reply is read; fake fetch, no network.
//   node bench/streets-fetch.test.js
"use strict";
const assert = require("node:assert/strict");
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
    replyWith({ elements: [way(1), way(2), count, ...ids(1, 2), count, ...ids(2), count, ...ids(2), count, ...ids(1), count] });
    const s = new StreetIndex({ newFrac: () => 1 });
    await s.ensureRects(rect, "bike");
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
    assert.equal(s.rects.length, 0, "the area is not recorded as fetched");
  }
  { // the box is scanned once; every list is filtered from that result (rescanning per list timed out Overpass)
    replyWith({ elements: [] });
    await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "run");
    assert.equal(sent.split("51.0000,13.7000").length - 1, 2, "one highway clause and one service clause");
    assert.match(sent, /->\.all;/);
  }
  { // walking and wheels both exclude motorroads; walking also foot=no
    replyWith({ elements: [] });
    await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "run");
    assert.match(sent, /\[motorroad!=yes\]\[foot!=no\]/);
    await new StreetIndex({ newFrac: () => 1 }).ensureRects(rect, "bike");
    assert.match(sent, /\[motorroad!=yes\]/);
    assert.doesNotMatch(sent, /foot!=no/);
  }
  console.log("streets-fetch.test.js ok");
})();
