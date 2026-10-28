// TileStore over IndexedDB, against the hand-rolled fake in bench/lib/fake-idb.js: eviction, the cost of a
// read, quota, a dead connection, a request that never answers.
//   node bench/tile-store-idb.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { createFakeIDB } = require("./lib/fake-idb.js");
const { TileStore } = global;

const HOUR = 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openIdb = async (fake, opts) => {
  global.indexedDB = fake;
  return TileStore.open("db", "tiles", Object.assign({ maxEntries: 3, timeoutMs: 60 }, opts));
};

(async () => {
  const warn = console.warn; console.warn = () => {};
  const realNow = Date.now;
  let clock = 1e12;
  Date.now = () => clock;
  try {
    { // round trip, keys, delete; the page can tell which backend it got
      const s = await openIdb(createFakeIDB());
      assert.equal(s.backend, "indexeddb");
      await s.put("a", { n: 1 });
      assert.deepEqual(await s.get("a"), { n: 1 });
      assert.equal(await s.get("b"), undefined);
      await s.put("b", 2);
      assert.deepEqual((await s.keys()).sort(), ["a", "b"]);
      await s.delete("a");
      assert.deepEqual(await s.keys(), ["b"]);
    }
    { // the fourth put into a store of three evicts the least recently used entry
      const s = await openIdb(createFakeIDB());
      for (const k of ["a", "b", "c", "d"]) { await s.put(k, k); clock += 10; }
      assert.deepEqual((await s.keys()).sort(), ["b", "c", "d"]);
    }
    { // a read old enough to matter counts as use, so the next oldest goes; a fresh read does not rewrite the answer
      const fake = createFakeIDB();
      const s = await openIdb(fake);
      for (const k of ["a", "b", "c"]) { await s.put(k, k); clock += 10; }
      clock += 2 * HOUR;
      assert.equal(await s.get("a"), "a");
      await sleep(20); // the touch runs behind the read
      await s.put("d", "d");
      assert.deepEqual((await s.keys()).sort(), ["a", "c", "d"]);
      const writes = fake.transactions.filter((t) => t.mode === "readwrite").length;
      await s.get("a");
      await sleep(20);
      assert.equal(fake.transactions.filter((t) => t.mode === "readwrite").length, writes, "a read just made writes nothing");
    }
    { // a read is readonly: a failed usedAt touch cannot take the answer with it
      const fake = createFakeIDB();
      const s = await openIdb(fake);
      await s.put("a", "a");
      clock += 2 * HOUR;
      fake.failPuts = 1; // the touch's write
      const before = fake.transactions.length;
      assert.equal(await s.get("a"), "a");
      assert.equal(fake.transactions[before].mode, "readonly");
      await sleep(20);
      assert.equal(await s.get("a"), "a", "still there, and still readable");
    }
    { // a full disk: the put evicts the oldest entry and tries once more
      const fake = createFakeIDB();
      const s = await openIdb(fake);
      for (const k of ["a", "b", "c"]) { await s.put(k, k); clock += 10; }
      fake.failPuts = 1;
      await s.put("d", "d");
      assert.equal(await s.get("d"), "d");
      assert.equal(await s.get("a"), undefined, "the oldest made room");
      fake.failPuts = 5; // still full after the eviction: the failure reaches the caller
      await assert.rejects(() => s.put("e", "e"), (e) => e.name === "QuotaExceededError");
      fake.failPuts = 0;
    }
    { // a connection closed by versionchange is reopened by the next call, not left dead
      const fake = createFakeIDB();
      const s = await openIdb(fake);
      await s.put("a", "a");
      fake.versionChange();
      assert.equal(await s.get("a"), "a");
      assert.equal(fake.opens, 2);
    }
    { // a connection the browser closed without telling us: one retry on a fresh one
      const fake = createFakeIDB();
      const s = await openIdb(fake);
      await s.put("a", "a");
      fake.connections[0].close();
      assert.equal(await s.get("a"), "a");
      assert.equal(fake.opens, 2);
    }
    { // an open that is blocked gives a memory store, and the connection that succeeds late is closed
      const fake = createFakeIDB();
      fake.blockOpen = true;
      const s = await openIdb(fake);
      assert.equal(s.backend, "memory");
      await sleep(30);
      assert.equal(fake.connections.length, 1);
      assert.equal(fake.connections[0].closed, true, "no leaked connection");
    }
    { // an open that never answers falls back to memory instead of hanging the page
      const fake = createFakeIDB();
      fake.hangOpen = true;
      const s = await openIdb(fake);
      assert.equal(s.backend, "memory");
      await s.put("a", 1);
      assert.equal(await s.get("a"), 1);
    }
    { // a request that never completes rejects, and the next call is on a new connection
      const fake = createFakeIDB();
      const s = await openIdb(fake);
      await s.put("a", "a");
      fake.hang = true;
      await assert.rejects(() => s.get("a"), (e) => e.name === "TimeoutError");
      fake.hang = false;
      assert.equal(await s.get("a"), "a");
      assert.equal(fake.opens, 2);
    }
    { // the memory store hands out copies, as IndexedDB does: a caller that mutates one corrupts nothing
      const s = TileStore.memory({ maxEntries: 3 });
      const v = { ways: [1] };
      await s.put("a", v);
      v.ways.push(2);
      const got = await s.get("a");
      assert.deepEqual(got, { ways: [1] });
      got.ways.push(3);
      assert.deepEqual(await s.get("a"), { ways: [1] });
      assert.equal(s.backend, "memory");
    }
    { // no maxEntries: nothing is ever evicted
      const s = await openIdb(createFakeIDB(), { maxEntries: undefined });
      for (let i = 0; i < 20; i++) await s.put("k" + i, i);
      assert.equal((await s.keys()).length, 20);
    }
  } finally { console.warn = warn; Date.now = realNow; delete global.indexedDB; }
  console.log("tile-store-idb.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
