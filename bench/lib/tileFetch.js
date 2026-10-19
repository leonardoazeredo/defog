// Street source for the bench: the query is built from the rects of the run's ensureRects call, not
// from the tiles, so it matches the entries in bench/cache/overpass/ when a scenario makes the same
// call; the answer is then split per tile.
"use strict";

// Assumes one ensureRects call per index: a later call replaces the rects the query is built from, and
// its text then differs from the saved one, so the cache misses.
function installTileFetch(streets) {
  const ensureRects = streets.ensureRects.bind(streets);
  let rects = null;
  streets.ensureRects = (r, kind) => { rects = r; return ensureRects(r, kind); };
  streets.fetchStreets = (tiles, kind) => global.StreetIndex.overpassFetch(tiles, kind, rects);
}

module.exports = { installTileFetch };
