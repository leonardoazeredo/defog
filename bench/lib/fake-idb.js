// Just enough IndexedDB for app/src/tileStore.js: one object store with a keyPath and secondary
// indexes, readonly/readwrite transactions that roll back on abort, and switches to make it fail
// the way a WebView does (quota, a closed or versionchanged connection, a request that never ends).
"use strict";

function createFakeIDB() {
  const dbs = new Map(); // name -> {stores: Map(storeName -> {keyPath, indexes: Map(name -> keyPath), rows: Map})}
  const fake = {
    opens: 0, transactions: [], connections: [],
    hang: false,        // requests never complete
    hangOpen: false,    // open never answers
    blockOpen: false,   // open reports blocked, then succeeds anyway
    failPuts: 0,        // the next n puts abort their transaction with QuotaExceededError
    versionChange() { for (const c of fake.connections) if (!c.closed && c.onversionchange) c.onversionchange(); },
    rows(name, store) { return dbs.get(name).stores.get(store).rows; },
    open(name) {
      fake.opens++;
      const req = {};
      const connect = () => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, { stores: new Map() });
        const data = dbs.get(name);
        const db = {
          closed: false, onversionchange: null,
          close() { db.closed = true; },
          createObjectStore(storeName, { keyPath }) {
            const st = { keyPath, indexes: new Map(), rows: new Map() };
            data.stores.set(storeName, st);
            return { createIndex: (idx, path) => st.indexes.set(idx, path) };
          },
          transaction(storeName, mode) {
            if (db.closed) throw Object.assign(new Error("closed"), { name: "InvalidStateError" });
            return makeTx(data.stores.get(storeName), mode);
          }
        };
        fake.connections.push(db);
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      };
      setTimeout(() => {
        if (fake.hangOpen) return;
        if (fake.blockOpen) { if (req.onblocked) req.onblocked(); setTimeout(connect, 5); return; }
        connect();
      }, 0);
      return req;
    }
  };

  function makeTx(st, mode) {
    const t = { error: null, oncomplete: null, onerror: null, onabort: null, pending: 0, done: false, mode };
    const snapshot = mode === "readwrite" ? new Map(st.rows) : null;
    fake.transactions.push(t);
    const settle = () => {
      if (t.done || t.pending > 0) return;
      setTimeout(() => {
        if (t.done || t.pending > 0) return;
        t.done = true;
        if (t.oncomplete) t.oncomplete();
      }, 0);
    };
    const abort = (err) => {
      if (t.done) return;
      t.done = true;
      t.error = err;
      if (snapshot) { st.rows.clear(); for (const [k, v] of snapshot) st.rows.set(k, v); }
      if (t.onerror) t.onerror();
      if (t.onabort) t.onabort();
    };
    t.abort = () => abort(null);
    const writable = () => {
      if (mode !== "readwrite") throw Object.assign(new Error("readonly"), { name: "ReadOnlyError" });
    };
    // a request runs on a later tick; whatever its onsuccess starts keeps the transaction open
    const request = (fn) => {
      const r = { result: undefined };
      t.pending++;
      setTimeout(() => {
        if (t.done || fake.hang) return;
        try { r.result = fn(); } catch (e) { t.pending--; abort(e); return; }
        if (r.onsuccess) r.onsuccess();
        t.pending--;
        settle();
      }, 0);
      return r;
    };
    t.objectStore = () => ({
      get: (key) => request(() => { const v = st.rows.get(key); return v && structuredClone(v); }),
      put: (value) => request(() => {
        writable();
        if (fake.failPuts > 0) { fake.failPuts--; throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); }
        st.rows.set(value[st.keyPath], structuredClone(value));
      }),
      delete: (key) => request(() => { writable(); st.rows.delete(key); }),
      count: () => request(() => st.rows.size),
      getAllKeys: () => request(() => [...st.rows.keys()]),
      index: (name) => ({
        openKeyCursor: () => {
          const path = st.indexes.get(name);
          const order = [...st.rows.values()].sort((a, b) => a[path] - b[path]).map((v) => v[st.keyPath]);
          let i = 0;
          const r = { result: undefined };
          const step = () => {
            t.pending++;
            setTimeout(() => {
              if (t.done || fake.hang) return;
              r.result = i < order.length ? { primaryKey: order[i], continue() { i++; step(); } } : null;
              if (r.onsuccess) r.onsuccess();
              t.pending--;
              settle();
            }, 0);
          };
          step();
          return r;
        }
      })
    });
    settle();
    return t;
  }
  return fake;
}

module.exports = { createFakeIDB };
