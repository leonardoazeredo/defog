// Cache-first street source: wraps a network street source (StreetIndex.overpassFetch) with a
// TileStore of per-tile answers, so a loop planned once in an area plans again with no
// connection. Overpass only ever sees the bounding boxes of tiles not held here.
(function (global) {
  const DAY_MS = 24 * 3600 * 1000;

  // Own key format, not StreetIndex.tileKey, so persisted keys do not follow changes to the
  // in-memory one. The leading version is the tile grid's: bump it whenever TILE_DEG in streets.js
  // changes, or answers fetched for the old grid are read as tiles of the new one.
  const keyOf = (kind, t) => "2:" + kind + ":" + t.x + ":" + t.y;
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
        // only the top-level shape StreetIndex reads (ways, groups); a stored answer without them would otherwise fail every run in the area
        const a = entry && entry.answer;
        if (!a || !Array.isArray(a.ways) || !a.groups || typeof entry.fetchedAt !== "number") continue;
        // a stamp ahead of now (clock moved back) cannot be trusted as fresh: refetch and overwrite it
        const age = now() - entry.fetchedAt;
        if (age >= 0 && age < maxAgeMs) return { answer: a, stale: false };
        stale = stale || { answer: entry.answer, stale: true };
      }
      return stale;
    }

    // The street source contract of StreetIndex: onTile hears each tile as it is known, cached
    // tiles first, and each network tile is stored the moment it arrives, so a failed run keeps it.
    async function fetchStreets(tiles, kind, onTile) {
      const state = { storeDown: false };
      const out = new Map();
      const missing = [];
      const expired = new Map(); // "x:y" -> an out-of-date answer, the fallback if the network is down
      const deliver = (t, answer) => {
        out.set(t.x + ":" + t.y, answer);
        if (onTile) onTile(t, answer);
      };
      for (const t of tiles) {
        const hit = await lookup(t, kind, state);
        if (hit && !hit.stale) deliver(t, hit.answer);
        else {
          missing.push(t);
          if (hit) expired.set(t.x + ":" + t.y, hit.answer);
        }
      }
      if (!missing.length) return out;

      const puts = [];
      const keep = (t, answer) => {
        if (!answer || out.has(t.x + ":" + t.y)) return;
        if (!state.storeDown) puts.push(store.put(keyOf(kind, t), { answer, fetchedAt: now() }).catch(() => { state.storeDown = true; }));
        deliver(t, answer);
      };
      let stopped = false; // the caller's onTile threw: it wants no more tiles, stale ones included
      let fresh;
      try {
        fresh = await network(missing, kind, (t, answer) => {
          try { keep(t, answer); } catch (e) { stopped = true; throw e; }
        });
      } catch (e) {
        await Promise.all(puts);
        const left = missing.filter((t) => !out.has(t.x + ":" + t.y));
        // old streets beat none when offline, but only if they cover everything still missing
        if (stopped || !left.every((t) => expired.has(t.x + ":" + t.y))) throw global.StreetIndex.downloadError(out.size, tiles.length, e);
        for (const t of left) deliver(t, expired.get(t.x + ":" + t.y));
        return out;
      }
      // a network source may hand tiles over in its Map alone
      for (const t of missing) keep(t, fresh && fresh.get(t.x + ":" + t.y));
      await Promise.all(puts);
      return out;
    }

    return { fetchStreets };
  }

  global.StreetCache = { create };
})(window);
