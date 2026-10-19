// A small key-value store with least-recently-used eviction, for caches that must never break the
// page: IndexedDB when the WebView has it, a plain in-memory Map when it does not or it fails to
// open. Values are structured-clone friendly; nothing is encrypted at rest.
(function (global) {
  // strictly increasing, so two operations in the same millisecond still order; Date.now keeps the
  // order across sessions for the persisted store
  let last = 0;
  const stamp = () => (last = Math.max(Date.now(), last + 1));

  function memory(opts) {
    const maxEntries = (opts && opts.maxEntries) || Infinity;
    const m = new Map(); // key -> {value, usedAt}
    return {
      async get(key) {
        const e = m.get(key);
        if (!e) return undefined;
        e.usedAt = stamp();
        return e.value;
      },
      async put(key, value) {
        m.set(key, { value, usedAt: stamp() });
        while (m.size > maxEntries) {
          let oldest = null;
          for (const [k, e] of m) if (oldest === null || e.usedAt < m.get(oldest).usedAt) oldest = k;
          m.delete(oldest);
        }
      },
      async delete(key) { m.delete(key); },
      async keys() { return [...m.keys()]; }
    };
  }

  function openDb(dbName, storeName) {
    return new Promise((resolve, reject) => {
      const req = global.indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        // the usedAt index orders eviction without reading the values, which can be large
        req.result.createObjectStore(storeName, { keyPath: "key" }).createIndex("usedAt", "usedAt");
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    });
  }

  function idbStore(db, storeName, maxEntries) {
    // resolves with whatever `work` hands to `out`, once the transaction has committed
    const tx = (mode, work) => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = t.onabort = () => reject(t.error || new Error("transaction aborted"));
      work(t.objectStore(storeName), (v) => { result = v; });
    });
    return {
      get: (key) => tx("readwrite", (os, out) => {
        const r = os.get(key);
        r.onsuccess = () => {
          const e = r.result;
          if (!e) return;
          e.usedAt = stamp();
          os.put(e);
          out(e.value);
        };
      }),
      put: (key, value) => tx("readwrite", (os) => {
        os.put({ key, value, usedAt: stamp() });
        const c = os.count();
        c.onsuccess = () => {
          let over = c.result - maxEntries;
          if (over <= 0) return;
          const cur = os.index("usedAt").openKeyCursor(); // oldest first
          cur.onsuccess = () => {
            const p = cur.result;
            if (!p || over-- <= 0) return;
            os.delete(p.primaryKey);
            p.continue();
          };
        };
      }),
      delete: (key) => tx("readwrite", (os) => { os.delete(key); }),
      keys: () => tx("readonly", (os, out) => {
        const r = os.getAllKeys();
        r.onsuccess = () => out(r.result);
      }).then((k) => k || [])
    };
  }

  // Never rejects: any failure to reach IndexedDB hands back a memory store, so callers need no
  // second path.
  async function open(dbName, storeName, opts) {
    const maxEntries = (opts && opts.maxEntries) || Infinity;
    try {
      if (!global.indexedDB) throw new Error("no indexedDB");
      return idbStore(await openDb(dbName, storeName), storeName, maxEntries);
    } catch (e) {
      console.warn("tile store: IndexedDB unavailable, caching in memory only");
      return memory(opts);
    }
  }

  global.TileStore = { open, memory };
})(window);
