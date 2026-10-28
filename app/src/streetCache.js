// Cache-first street source: wraps a network street source (StreetIndex.overpassFetch) with a
// TileStore of per-tile answers, so a loop planned once in an area plans again with no
// connection. Overpass only ever sees the bounding boxes of tiles not held here.
(function (global) {
  const DAY_MS = 24 * 3600 * 1000;

  // Own key format, not StreetIndex.tileKey, so persisted keys do not follow changes to the
  // in-memory one. The leading version is the tile grid's: bump it whenever TILE_DEG in streets.js
  // changes, or answers fetched for the old grid are read as tiles of the new one.
  // The same prefix is the schema version of a stored entry: change the answer format and the prefix
  // together, and old entries are never read (sweepLegacy leaves them; they go only when LRU eviction reaches them, once the store is full).
  const KEY_VERSION = "2:";
  const idOf = (t) => t.x + ":" + t.y;
  const keyOf = (kind, t) => KEY_VERSION + kind + ":" + idOf(t);
  // old keys removed per open: the sweep must not hold up a store that still has hundreds
  const LEGACY_SWEEP_MAX = 256;
  // what a failed download carries (Overpass.post's reasons, and the default source's "streets-partial"
  // when some tiles arrived first): only these stand for an outage; any other throw is a bug and
  // must not be answered with old streets. Kept here, not read from streets.js, which loads after.
  const OUTAGE_REASONS = new Set(["busy", "blocked", "stalled", "offline", "server", "streets-partial"]);
  // a run tile also stands in for bike, as in StreetIndex._uncovered: the run query drops foot=no
  // ways, so the answer can miss a few bike-only ways.
  const kindsFor = (kind) => (kind === "bike" ? ["bike", "run"] : [kind]);

  function create(opts) {
    const { store, network, now } = opts;
    const maxAgeMs = opts.maxAgeMs == null ? 90 * DAY_MS : opts.maxAgeMs;
    let warned = false; // a full or broken store fails every call: one line says so
    const storeFailed = (state, what, e) => {
      state.storeDown = true;
      if (!warned) { warned = true; console.warn("[streets] cache " + what + " failed", e && e.name); }
    };

    const sound = (a) => a.ways.every((w) => w && typeof w === "object") && typeof a.groups === "object" && Object.values(a.groups).every((g) => g == null || typeof g[Symbol.iterator] === "function");

    // The stored answer for a tile: {answer, stale}, or null. A store that throws counts as
    // empty for the rest of the call, so one dead database costs one failure, not one per tile.
    async function lookup(tile, kind, state) {
      let stale = null;
      for (const k of kindsFor(kind)) {
        if (state.storeDown) return stale;
        let entry;
        try { entry = await store.get(keyOf(k, tile)); }
        catch (e) { storeFailed(state, "read", e); return stale; }
        // only the top-level shape StreetIndex reads (ways, groups); a stored answer without them would otherwise fail every run in the area
        const a = entry && entry.answer;
        if (!a || !Array.isArray(a.ways) || !a.groups || typeof entry.fetchedAt !== "number") continue;
        // the deeper check: a way that is not an object, or a group that cannot be iterated, would fail every run in the area too: a miss, and removed (a malformed field inside a way is not checked)
        if (!sound(a)) { store.delete(keyOf(k, tile)).catch(() => {}); continue; }
        // a stamp ahead of now (clock moved back) cannot be trusted as fresh: refetch and overwrite it
        const age = now() - entry.fetchedAt;
        if (age >= 0 && age < maxAgeMs) return { answer: a, stale: false };
        stale = stale || { answer: entry.answer, stale: true };
      }
      return stale;
    }

    // The street source contract of StreetIndex: onTile hears each tile as it arrives, cached tiles
    // first, and each network tile is stored the moment it arrives, so a failed run keeps it. An
    // expired copy never goes through onTile: served after a network failure (below), or read with
    // opts.cacheOnly, it comes back in the returned Map alone. A failure rethrows the network's error
    // as it is; ensureRects counts tiles. opts.cacheOnly: what the store holds and nothing else, never
    // the network, so the Streets in fog look can draw on every pan without spending the server's
    // daily share. The run's other opts (its clock, busy wait and stale) go to the network source, so a
    // busy wait keeps to the run's deadline and stop, and a replaced run's posts still waiting for a slot
    // are not sent.
    async function fetchStreets(tiles, kind, onTile, opts) {
      const state = { storeDown: false };
      const out = new Map();
      const missing = [];
      const expired = new Map(); // "x:y" -> an out-of-date answer, the fallback if the network is down
      let stopped = false; // the caller's onTile or busy wait threw (its stop, or a bug): no more tiles, stale ones included
      // a stored answer goes to onTile with {cached: true}: ensureRects counts only the others as downloaded
      const deliver = (t, answer, cached) => {
        out.set(idOf(t), answer);
        if (!onTile) return;
        try { if (cached) onTile(t, answer, { cached: true }); else onTile(t, answer); } catch (e) { stopped = true; throw e; }
      };
      for (const t of tiles) {
        const hit = await lookup(t, kind, state);
        if (hit && !hit.stale) deliver(t, hit.answer, true);
        else {
          missing.push(t);
          if (hit) expired.set(idOf(t), hit.answer);
        }
      }
      if (opts && opts.cacheOnly) {
        for (const [k, answer] of expired) out.set(k, answer);
        return out;
      }
      if (!missing.length) return out;

      const puts = [];
      const keep = (t, answer) => {
        if (!answer || out.has(idOf(t))) return;
        if (!state.storeDown) puts.push(store.put(keyOf(kind, t), { answer, fetchedAt: now() }).catch((e) => storeFailed(state, "write", e)));
        deliver(t, answer);
      };
      // a throw from the run's busy wait is the caller's stop too, like one from onTile
      const wait = opts && opts.wait;
      const netOpts = wait ? Object.assign({}, opts, { wait: async (until) => {
        try { return await wait(until); } catch (e) { stopped = true; throw e; }
      } }) : opts;
      let fresh;
      try {
        fresh = await network(missing, kind, keep, netOpts);
      } catch (e) {
        await Promise.all(puts);
        const left = missing.filter((t) => !out.has(idOf(t)));
        // old streets beat none when offline, but only if they cover everything still missing; a throw
        // with no outage reason is a bug, which old streets must not hide; a replaced run is given none
        if (stopped || (opts && opts.stale && opts.stale()) || !OUTAGE_REASONS.has(e && e.reason) || !left.every((t) => expired.has(idOf(t)))) throw e;
        console.warn("[streets] offline: serving " + left.length + " expired tile(s) from the cache (" + e.reason + ")");
        // in the Map alone, past onTile: they cost no request, so the caller's per-tile stop (the run
        // deadline) must not cut them off
        for (const t of left) out.set(idOf(t), expired.get(idOf(t)));
        return out;
      }
      // a network source may hand tiles over in its Map alone
      for (const t of missing) keep(t, fresh && fresh.get(idOf(t)));
      await Promise.all(puts);
      return out;
    }

    // Removes each entry whose name has no leading version number (numbered entries stay, so an older build never deletes a newer build's), at most LEGACY_SWEEP_MAX per call; the caller
    // starts it without awaiting. Resolves with how many went and never rejects.
    async function sweepLegacy() {
      let n = 0;
      try {
        const old = (await store.keys()).filter((k) => !/^\d+:/.test(k)).slice(0, LEGACY_SWEEP_MAX);
        for (const k of old) { await store.delete(k); n++; }
      } catch (e) { console.warn("[streets] cache sweep failed", e && e.name); }
      return n;
    }

    return { fetchStreets, sweepLegacy };
  }

  global.StreetCache = { create };
})(window);
