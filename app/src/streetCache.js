// Cache-first street source: wraps a network street source (StreetIndex.overpassFetch) with a
// TileStore of per-tile answers, so a loop planned once in an area plans again with no
// connection. Overpass only ever sees the bounding boxes of tiles not held here.
(function (global) {
  const DAY_MS = 24 * 3600 * 1000;

  // Own key format, not StreetIndex.tileKey: these keys are persisted and must outlive any
  // change to the in-memory one.
  const keyOf = (kind, t) => kind + ":" + t.x + ":" + t.y;
  // a run tile also stands in for bike, as in StreetIndex._uncovered: the run query drops foot=no
  // ways, so the answer can miss a few bike-only ways. Only a car fetch holds motorways.
  const kindsFor = (kind) => (kind === "bike" ? ["bike", "run"] : [kind]);

  function create(opts) {
    const { store, network, now } = opts;
    const maxAgeMs = opts.maxAgeMs == null ? 90 * DAY_MS : opts.maxAgeMs;

    // The stored answer for a tile: {answer, stale}, or null. A store that throws counts as
    // empty for the rest of the call, so one dead database costs one failure, not one per tile.
    async function lookup(tile, kind, state) {
      let stale = null;
      for (const k of kindsFor(kind)) {
        if (state.storeDown) return stale;
        let entry;
        try { entry = await store.get(keyOf(k, tile)); }
        catch (e) { state.storeDown = true; return stale; }
        if (!entry || !entry.answer || typeof entry.fetchedAt !== "number") continue;
        if (now() - entry.fetchedAt < maxAgeMs) return { answer: entry.answer, stale: false };
        stale = stale || { answer: entry.answer, stale: true };
      }
      return stale;
    }

    async function fetchStreets(tiles, kind) {
      const state = { storeDown: false };
      const out = new Map();
      const missing = [];
      const expired = new Map(); // "x:y" -> an out-of-date answer, the fallback if the network is down
      for (const t of tiles) {
        const hit = await lookup(t, kind, state);
        if (hit && !hit.stale) out.set(t.x + ":" + t.y, hit.answer);
        else {
          missing.push(t);
          if (hit) expired.set(t.x + ":" + t.y, hit.answer);
        }
      }
      if (!missing.length) return out;

      let fresh;
      try { fresh = await network(missing, kind); }
      catch (e) {
        // old streets beat none when offline, but only if they cover everything asked for
        if (!missing.every((t) => expired.has(t.x + ":" + t.y))) throw e;
        for (const t of missing) out.set(t.x + ":" + t.y, expired.get(t.x + ":" + t.y));
        return out;
      }
      const fetchedAt = now();
      await Promise.all(missing.map(async (t) => {
        const id = t.x + ":" + t.y;
        const answer = fresh.get(id);
        if (!answer) return;
        out.set(id, answer);
        if (state.storeDown) return;
        try { await store.put(keyOf(kind, t), { answer, fetchedAt }); }
        catch (e) { state.storeDown = true; }
      }));
      return out;
    }

    return { fetchStreets };
  }

  global.StreetCache = { create };
})(window);
