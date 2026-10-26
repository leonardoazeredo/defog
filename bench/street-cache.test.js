// StreetCache: cache-first street source over a TileStore; fake network that records its calls.
//   node bench/street-cache.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { TileStore, StreetCache, StreetIndex } = global;

const DAY = 24 * 3600 * 1000;
const answerFor = (t, kind) => ({ ways: [{ id: t.x * 1000 + t.y, nodes: [1, 2], geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] }], groups: { tag: kind } });
function fakeNetwork() {
  const calls = [];
  const network = async (tiles, kind, onTile) => {
    calls.push({ tiles, kind });
    const out = new Map();
    for (const t of tiles) {
      out.set(t.x + ":" + t.y, answerFor(t, kind));
      if (onTile) onTile(t, out.get(t.x + ":" + t.y));
    }
    return out;
  };
  return { network, calls };
}
const T = (x, y) => ({ x, y });

(async () => {
  { // a cold request fetches and stores; the same request again makes no network call
    const { network, calls } = fakeNetwork();
    const c = StreetCache.create({ store: TileStore.memory({ maxEntries: 10 }), network, now: () => 0 });
    const first = await c.fetchStreets([T(1, 2)], "run");
    const again = await c.fetchStreets([T(1, 2)], "run");
    assert.equal(calls.length, 1);
    assert.deepEqual(again.get("1:2"), first.get("1:2"));
    assert.deepEqual(first.get("1:2"), answerFor(T(1, 2), "run"));
  }
  { // three tiles with two cached: only the third goes out, and the union comes back
    const { network, calls } = fakeNetwork();
    const c = StreetCache.create({ store: TileStore.memory({ maxEntries: 10 }), network, now: () => 0 });
    await c.fetchStreets([T(1, 1), T(2, 1)], "run");
    const got = await c.fetchStreets([T(1, 1), T(2, 1), T(3, 1)], "run");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].tiles, [T(3, 1)]);
    assert.deepEqual([...got.keys()].sort(), ["1:1", "2:1", "3:1"]);
  }
  { // a tile older than maxAgeMs is refetched, a younger one is not
    const { network, calls } = fakeNetwork();
    let t = 0;
    const c = StreetCache.create({ store: TileStore.memory({ maxEntries: 10 }), network, now: () => t, maxAgeMs: 90 * DAY });
    await c.fetchStreets([T(1, 1)], "run");
    t = 89 * DAY;
    await c.fetchStreets([T(1, 1)], "run");
    assert.equal(calls.length, 1);
    t = 91 * DAY;
    await c.fetchStreets([T(1, 1)], "run");
    assert.equal(calls.length, 2);
  }
  { // a cached run tile answers a bike request; a bike tile does not answer run, and nothing answers car
    const { network, calls } = fakeNetwork();
    const c = StreetCache.create({ store: TileStore.memory({ maxEntries: 10 }), network, now: () => 0 });
    await c.fetchStreets([T(1, 1)], "run");
    const bike = await c.fetchStreets([T(1, 1)], "bike");
    assert.equal(calls.length, 1, "bike served from the run tile");
    assert.equal(bike.get("1:1").groups.tag, "run");
    await c.fetchStreets([T(1, 1)], "car");
    assert.equal(calls.length, 2, "car needs its own fetch");
    assert.equal(calls[1].kind, "car");
    await c.fetchStreets([T(5, 5)], "bike");
    await c.fetchStreets([T(5, 5)], "run");
    assert.equal(calls.length, 4, "a bike tile does not answer run");
  }
  { // the bike answer is stored under bike, and a later bike request finds it first
    const { network, calls } = fakeNetwork();
    const c = StreetCache.create({ store: TileStore.memory({ maxEntries: 10 }), network, now: () => 0 });
    await c.fetchStreets([T(5, 5)], "bike");
    await c.fetchStreets([T(5, 5)], "bike");
    assert.equal(calls.length, 1);
  }
  { // a store whose get throws still returns the network answer, and asks the network for every tile
    const { network, calls } = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    store.get = async () => { throw new Error("idb dead"); };
    const c = StreetCache.create({ store, network, now: () => 0 });
    const got = await c.fetchStreets([T(1, 1), T(2, 1)], "run");
    assert.equal(calls.length, 1);
    assert.deepEqual([...got.keys()].sort(), ["1:1", "2:1"]);
  }
  { // a store whose put throws does not fail the request
    const { network } = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    store.put = async () => { throw new Error("quota"); };
    const c = StreetCache.create({ store, network, now: () => 0 });
    const got = await c.fetchStreets([T(1, 1)], "run");
    assert.ok(got.get("1:1"));
  }
  { // a damaged entry counts as a miss
    const { network, calls } = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    await store.put("2:run:1:1", { junk: true });
    const c = StreetCache.create({ store, network, now: () => 0 });
    await c.fetchStreets([T(1, 1)], "run");
    assert.equal(calls.length, 1);
  }
  { // a network failure is an error, unless every missing tile has an expired copy: then those serve
    let fail = false;
    const base = fakeNetwork();
    const network = async (tiles, kind) => { if (fail) throw new Error("offline"); return base.network(tiles, kind); };
    let t = 0;
    const c = StreetCache.create({ store: TileStore.memory({ maxEntries: 10 }), network, now: () => t, maxAgeMs: 90 * DAY });
    await c.fetchStreets([T(1, 1)], "run");
    t = 200 * DAY; fail = true;
    const got = await c.fetchStreets([T(1, 1)], "run");
    assert.deepEqual(got.get("1:1"), answerFor(T(1, 1), "run"), "expired copy serves offline");
    await assert.rejects(() => c.fetchStreets([T(1, 1), T(9, 9)], "run"), /offline/);
  }
  { // end to end with StreetIndex: a second index over the same store never touches the network
    const { network, calls } = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    const rect = [{ s: 51, w: 13.7, n: 51.01, e: 13.71 }];
    const a = new StreetIndex({ newFrac: () => 1, fetchStreets: StreetCache.create({ store, network, now: () => 0 }).fetchStreets });
    await a.ensureRects(rect, "run");
    const b = new StreetIndex({ newFrac: () => 1, fetchStreets: StreetCache.create({ store, network, now: () => 0 }).fetchStreets });
    await b.ensureRects(rect, "run");
    assert.equal(calls.length, 1);
    assert.equal(b.ways.length, a.ways.length);
  }
  { // one dead store costs one failed read for the whole call, not one per tile
    const { network } = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    let gets = 0;
    store.get = async () => { gets++; throw new Error("idb dead"); };
    await StreetCache.create({ store, network, now: () => 0 }).fetchStreets([T(1, 1), T(2, 1), T(3, 1)], "run");
    assert.equal(gets, 1);
  }
  { // a network answer missing a tile comes back as it is, and only the tiles it holds are stored
    const base = fakeNetwork();
    const network = async (tiles, kind) => { const m = await base.network(tiles, kind); m.delete("2:1"); return m; }; // no onTile: the Map alone
    const store = TileStore.memory({ maxEntries: 10 });
    const got = await StreetCache.create({ store, network, now: () => 0 }).fetchStreets([T(1, 1), T(2, 1)], "run");
    assert.deepEqual([...got.keys()], ["1:1"]);
    assert.deepEqual(await store.keys(), ["2:run:1:1"]);
  }
  { // the cache is installed on an index that already exists, as main.js does once the store opens
    const { network, calls } = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    const warm = StreetCache.create({ store, network, now: () => 0 });
    await warm.fetchStreets(StreetIndex.tilesCovering({ s: 51, w: 13.7, n: 51.01, e: 13.71 }), "run");
    const idx = new StreetIndex({ newFrac: () => 1, fetchStreets: network });
    idx.fetchStreets = warm.fetchStreets;
    await idx.ensureRects([{ s: 51, w: 13.7, n: 51.01, e: 13.71 }], "run");
    assert.equal(calls.length, 1, "the swapped-in cache answered");
  }
  { // entries of the wrong shape, or stamped in the future, are refetched and overwritten
    const { network, calls } = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    await store.put("2:run:1:1", { answer: { ways: "x", groups: {} }, fetchedAt: 0 });
    await store.put("2:run:2:1", { answer: { ways: [], groups: {} }, fetchedAt: 5000 });
    const c = StreetCache.create({ store, network, now: () => 0 });
    await c.fetchStreets([T(1, 1), T(2, 1)], "run");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tiles.length, 2);
    assert.deepEqual((await store.get("2:run:1:1")).answer, answerFor(T(1, 1), "run"));
    assert.deepEqual((await store.get("2:run:2:1")).answer, answerFor(T(2, 1), "run"));
  }
  { // tiles that arrived before the network failed are stored and handed on; the error is the network's own, counted by ensureRects
    const base = fakeNetwork();
    const network = async (tiles, kind, onTile) => {
      await base.network(tiles.slice(0, 1), kind, onTile);
      throw Object.assign(new Error("overpass HTTP 502"), { reason: "busy" });
    };
    const store = TileStore.memory({ maxEntries: 10 });
    await StreetCache.create({ store, network: base.network, now: () => 0 }).fetchStreets([T(0, 0)], "run");
    const seen = [];
    const err = await StreetCache.create({ store, network, now: () => 0 })
      .fetchStreets([T(0, 0), T(1, 1), T(2, 1)], "run", (t) => seen.push(t.x + ":" + t.y)).then(() => null, (e) => e);
    assert.deepEqual(seen, ["0:0", "1:1"], "the cached tile, then the one that arrived");
    assert.deepEqual((await store.keys()).sort(), ["2:run:0:0", "2:run:1:1"]);
    assert.deepEqual([err.message, err.reason], ["overpass HTTP 502", "busy"]);
  }
  { // an unversioned key is never read, so no answer is served for a tile of another grid
    const { network, calls } = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    await store.put("run:1:1", { answer: { ways: [], groups: {} }, fetchedAt: 0 });
    await StreetCache.create({ store, network, now: () => 0 }).fetchStreets([T(1, 1)], "run");
    assert.equal(calls.length, 1);
    assert.ok(await store.get("2:run:1:1"), "the answer is stored under the versioned key");
  }
  { // onTile hears every tile once, cached ones first, then each network tile as it arrives
    const { network } = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    const c = StreetCache.create({ store, network, now: () => 0 });
    await c.fetchStreets([T(2, 1)], "run");
    const seen = [];
    const got = await c.fetchStreets([T(1, 1), T(2, 1), T(3, 1)], "run", (t, answer) => seen.push([t.x + ":" + t.y, answer.ways[0].id]));
    assert.deepEqual(seen, [["2:1", 2001], ["1:1", 1001], ["3:1", 3001]]);
    assert.deepEqual([...got.keys()].sort(), ["1:1", "2:1", "3:1"]);
  }
  { // offline after some tiles arrived: the rest serve from expired copies when every one of them has one,
    // in the returned Map only, so a caller's stop on each tile (the run deadline) cannot cut them off
    let t = 0;
    const base = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    const c = StreetCache.create({ store, network: base.network, now: () => t, maxAgeMs: 90 * DAY });
    await c.fetchStreets([T(2, 1)], "run");
    t = 200 * DAY;
    const network = async (tiles, kind, onTile) => { await base.network(tiles.slice(0, 1), kind, onTile); throw new Error("offline"); };
    const seen = [];
    const got = await StreetCache.create({ store, network, now: () => t, maxAgeMs: 90 * DAY })
      .fetchStreets([T(1, 1), T(2, 1)], "run", (tile) => seen.push(tile.x + ":" + tile.y));
    assert.deepEqual(seen, ["1:1"]);
    assert.deepEqual([...got.keys()].sort(), ["1:1", "2:1"]);
    assert.equal((await store.get("2:run:2:1")).fetchedAt, 0, "the expired copy is served, not restamped");
  }
  { // a caller that stops the run (its onTile throws) gets no expired copies in its place
    let t = 0;
    const base = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    await StreetCache.create({ store, network: base.network, now: () => t }).fetchStreets([T(2, 1)], "run");
    t = 200 * DAY;
    const stop = Object.assign(new Error("deadline"), { reason: "stalled" });
    const err = await StreetCache.create({ store, network: base.network, now: () => t, maxAgeMs: 90 * DAY })
      .fetchStreets([T(1, 1), T(2, 1)], "run", () => { throw stop; }).then(() => null, (e) => e);
    assert.equal(err, stop, "the stop is the rejection");
    assert.equal(base.calls[1].tiles.length, 2);
  }
  { // a bug in the caller's onTile comes back as itself, with no expired copies in its place
    let t = 0;
    const base = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    await StreetCache.create({ store, network: base.network, now: () => t }).fetchStreets([T(1, 1), T(2, 1)], "run");
    t = 200 * DAY;
    const bug = new TypeError("bug");
    const err = await StreetCache.create({ store, network: base.network, now: () => t, maxAgeMs: 90 * DAY })
      .fetchStreets([T(1, 1), T(2, 1)], "run", () => { throw bug; }).then(() => null, (e) => e);
    assert.equal(err, bug);
  }
  { // a failed store write is logged once per cache, by the error's name alone
    const { network } = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    store.put = async () => { throw new DOMException("quota", "QuotaExceededError"); };
    const warned = [];
    const warn = console.warn;
    console.warn = (...a) => warned.push(a);
    try {
      const c = StreetCache.create({ store, network, now: () => 0 });
      await c.fetchStreets([T(1, 1)], "run");
      await c.fetchStreets([T(2, 1)], "run");
    } finally { console.warn = warn; }
    assert.deepEqual(warned, [["[streets] cache write failed", "QuotaExceededError"]]);
  }
  { // a failed store read is logged once per cache, by the error's name alone (no write is tried after it)
    const { network } = fakeNetwork();
    const store = TileStore.memory({ maxEntries: 10 });
    store.get = async () => { throw new DOMException("idb dead", "InvalidStateError"); };
    const warned = [];
    const warn = console.warn;
    console.warn = (...a) => warned.push(a);
    try {
      const c = StreetCache.create({ store, network, now: () => 0 });
      await c.fetchStreets([T(1, 1)], "run");
      await c.fetchStreets([T(2, 1)], "run", null, { cacheOnly: true });
    } finally { console.warn = warn; }
    assert.deepEqual(warned, [["[streets] cache read failed", "InvalidStateError"]]);
  }
  { // the run deadline passes while the request fails and every tile has an expired copy: the run still
    // gets every tile, since expired copies cost no request
    let t = 0;
    const clock = { t: 0 };
    const rect = { s: 51.0, w: 13.7, n: 51.025, e: 13.775 };
    const tiles = StreetIndex.tilesCovering(rect);
    assert.equal(tiles.length, 3);
    const store = TileStore.memory({ maxEntries: 10 });
    for (const tile of tiles) await store.put("2:run:" + tile.x + ":" + tile.y, { answer: answerFor(tile, "run"), fetchedAt: 0 });
    t = 200 * DAY;
    const network = async () => { clock.t += 80000; throw Object.assign(new Error("overpass: no answer"), { reason: "stalled" }); };
    const c = StreetCache.create({ store, network, now: () => t, maxAgeMs: 90 * DAY });
    const s = new StreetIndex({ newFrac: () => 1, fetchStreets: c.fetchStreets, now: () => clock.t });
    const progress = [];
    await s.ensureRects([rect], "run", { onProgress: (p) => progress.push(p.done) });
    assert.equal(s.tiles.size, 3);
    assert.deepEqual(progress, [0, 1, 2, 3]);
  }
  { // cache only: fresh tiles through onTile, an expired one in the Map alone, a missing one left out, no network
    const { network, calls } = fakeNetwork();
    let t = 0;
    const store = TileStore.memory({ maxEntries: 10 });
    const c = StreetCache.create({ store, network, now: () => t, maxAgeMs: 90 * DAY });
    await c.fetchStreets([T(1, 1)], "run");
    t = 200 * DAY;
    await c.fetchStreets([T(2, 1)], "run");
    const heard = [];
    const got = await c.fetchStreets([T(1, 1), T(2, 1), T(3, 1)], "run", (tile) => heard.push(tile.x), { cacheOnly: true });
    assert.equal(calls.length, 2, "a cache-only read never calls the network, not even for the expired tile");
    assert.deepEqual(heard, [2], "only the fresh tile is heard as it arrives");
    assert.deepEqual([...got.keys()].sort(), ["1:1", "2:1"], "the expired copy comes back, the missing tile does not");
    assert.deepEqual(got.get("1:1"), answerFor(T(1, 1), "run"));
    const bike = await c.fetchStreets([T(2, 1)], "bike", null, { cacheOnly: true });
    assert.deepEqual(bike.get("2:1"), answerFor(T(2, 1), "run"), "a run tile still stands in for bike");
  }
  console.log("street-cache.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
