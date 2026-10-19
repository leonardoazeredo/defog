// StreetCache: cache-first street source over a TileStore; fake network that records its calls.
//   node bench/street-cache.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { TileStore, StreetCache } = global;

const DAY = 24 * 3600 * 1000;
const answerFor = (t, kind) => ({ ways: [{ id: t.x * 1000 + t.y, nodes: [1, 2], geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] }], groups: { tag: kind } });
function fakeNetwork() {
  const calls = [];
  const network = async (tiles, kind) => {
    calls.push({ tiles, kind });
    return new Map(tiles.map((t) => [t.x + ":" + t.y, answerFor(t, kind)]));
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
    await store.put("run:1:1", { junk: true });
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
    const { StreetIndex } = global;
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
    const network = async (tiles, kind) => { const m = await base.network(tiles, kind); m.delete("2:1"); return m; };
    const store = TileStore.memory({ maxEntries: 10 });
    const got = await StreetCache.create({ store, network, now: () => 0 }).fetchStreets([T(1, 1), T(2, 1)], "run");
    assert.deepEqual([...got.keys()], ["1:1"]);
    assert.deepEqual(await store.keys(), ["run:1:1"]);
  }
  { // the cache is installed on an index that already exists, as main.js does once the store opens
    const { StreetIndex } = global;
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
    await store.put("run:1:1", { answer: { ways: "x", groups: {} }, fetchedAt: 0 });
    await store.put("run:2:1", { answer: { ways: [], groups: {} }, fetchedAt: 5000 });
    const c = StreetCache.create({ store, network, now: () => 0 });
    await c.fetchStreets([T(1, 1), T(2, 1)], "run");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tiles.length, 2);
    assert.deepEqual((await store.get("run:1:1")).answer, answerFor(T(1, 1), "run"));
    assert.deepEqual((await store.get("run:2:1")).answer, answerFor(T(2, 1), "run"));
  }
  console.log("street-cache.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
