// Street source for the bench: the query is built from the rects of the run's ensureRects call, not
// from the tiles, so it matches the entries in bench/cache/overpass/ when a scenario makes the same
// call; the answer is then split per tile and each tile handed to onTile, as the app's sources do.
"use strict";

// Assumes one ensureRects call per index: a later call replaces the rects the query is built from, and
// its text then differs from the saved one, so the cache misses.
function installTileFetch(streets) {
  const ensureRects = streets.ensureRects.bind(streets);
  let rects = null;
  streets.ensureRects = (r, kind, opts) => { rects = r; return ensureRects(r, kind, opts); };
  streets.fetchStreets = async (tiles, kind, onTile) => {
    const q = global.StreetIndex.rectQuery(rects, kind);
    const answers = global.StreetIndex.splitAnswer(await global.Overpass.post("data=" + encodeURIComponent(q)), tiles);
    if (onTile) for (const t of tiles) onTile(t, answers.get(global.StreetIndex.tileId(t)));
    return answers;
  };
}

module.exports = { installTileFetch };
