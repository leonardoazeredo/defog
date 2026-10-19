// TileStore: the memory store's LRU rules, and the fallback when IndexedDB is missing or fails to open.
//   node bench/tile-store.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { TileStore } = global;

(async () => {
  { // put/get round trip, a missing key is undefined
    const s = TileStore.memory({ maxEntries: 10 });
    await s.put("a", { n: 1 });
    assert.deepEqual(await s.get("a"), { n: 1 });
    assert.equal(await s.get("b"), undefined);
  }
  { // the fourth put into a store of three evicts the least recently used entry
    const s = TileStore.memory({ maxEntries: 3 });
    for (const k of ["a", "b", "c", "d"]) await s.put(k, k);
    assert.equal(await s.get("a"), undefined);
    assert.deepEqual((await s.keys()).sort(), ["b", "c", "d"]);
  }
  { // a get counts as use: the entry read last survives, the next oldest goes
    const s = TileStore.memory({ maxEntries: 3 });
    for (const k of ["a", "b", "c"]) await s.put(k, k);
    await s.get("a");
    await s.put("d", "d");
    assert.equal(await s.get("b"), undefined);
    assert.equal(await s.get("a"), "a");
  }
  { // overwriting a key is not growth
    const s = TileStore.memory({ maxEntries: 2 });
    await s.put("a", 1); await s.put("b", 2); await s.put("a", 3);
    assert.deepEqual((await s.keys()).sort(), ["a", "b"]);
    assert.equal(await s.get("a"), 3);
  }
  { // delete and keys
    const s = TileStore.memory({ maxEntries: 5 });
    await s.put("a", 1); await s.put("b", 2);
    await s.delete("a");
    await s.delete("nope");
    assert.deepEqual(await s.keys(), ["b"]);
  }
  { // no IndexedDB in the page: open still answers, with a working memory store
    delete global.indexedDB;
    const warned = [];
    const warn = console.warn; console.warn = (...a) => warned.push(a.join(" "));
    try {
      const s = await TileStore.open("db", "tiles", { maxEntries: 2 });
      await s.put("a", 1);
      assert.equal(await s.get("a"), 1);
    } finally { console.warn = warn; }
    assert.equal(warned.length, 1, "one warning");
  }
  { // IndexedDB that throws on open, fails with an error event, or never gets past a block: still a memory store
    const failures = {
      throws: () => { throw new Error("SecurityError"); },
      errors: () => { const r = {}; setTimeout(() => r.onerror && r.onerror()); return r; },
      blocked: () => { const r = {}; setTimeout(() => r.onblocked && r.onblocked()); return r; }
    };
    const warn = console.warn; console.warn = () => {};
    try {
      for (const [name, open] of Object.entries(failures)) {
        global.indexedDB = { open };
        const s = await TileStore.open("db", "tiles", { maxEntries: 2 });
        await s.put("a", 1);
        assert.equal(await s.get("a"), 1, name);
      }
    } finally { console.warn = warn; delete global.indexedDB; }
  }
  console.log("tile-store.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
