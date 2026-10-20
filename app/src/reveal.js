// Reveal: the cells of Fog of World's grid that a recorded track explores, under versioned rules.
// Pure: same track and rules, same cells. Results are only comparable within one RULES.version, so bump it on any change to the rules.
(function (global) {
  const { lngLatToCell, cellToLngLat, WORLD_CELLS } = global.FogParser;

  // Placeholder numbers; they are tuned on real walks and the version is bumped when they change.
  const RULES = Object.freeze({ version: 1, maxAccuracyM: 50, maxGapS: 60, maxGapM: 150, halfWidthM: 12 });

  const RAD = Math.PI / 180;
  const R = 6378137; // the sphere the grid is drawn on, so a cell is 2*pi*R/WORLD_CELLS wide at the equator
  const MAX_LAT = 85.0511; // lngLatToCell's cy leaves the grid beyond this latitude
  const CELL_M_EQ = 2 * Math.PI * R / WORLD_CELLS;
  // compact the key buffer at this size so memory follows the unique cells, not the number of points
  const FLUSH_AT = 1 << 20;

  const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

  function checkRules(rules) {
    for (const k of ["maxAccuracyM", "maxGapS", "maxGapM", "halfWidthM"]) {
      if (!(rules[k] >= 0) || !Number.isFinite(rules[k])) throw new Error("reveal rule " + k + " must be a finite number >= 0");
    }
  }

  // sorts and dedupes the cx * WORLD_CELLS + cy keys so the buffer stays bounded on a long track
  function compact(keys) {
    const a = Float64Array.from(keys).sort();
    const out = [];
    for (let i = 0; i < a.length; i++) if (i === 0 || a[i] !== a[i - 1]) out.push(a[i]);
    return out;
  }

  // Cells whose centre lies within h metres of the segment a-b (a === b is a disc), pushed as keys.
  // Distances are in a flat frame at the segment's mean latitude. Longitudes are not wrapped here: a disc at the
  // antimeridian reaches past the grid edge, and the cells there are wrapped to the other side when stored.
  function addSegment(keys, a, b, h) {
    const lat0 = (a.lat + b.lat) / 2;
    const kx = R * RAD * Math.cos(lat0 * RAD), ky = R * RAD;
    const ax = a.lon * kx, ay = a.lat * ky, dx = b.lon * kx - ax, dy = b.lat * ky - ay;
    const len2 = dx * dx + dy * dy;
    // the grid is conformal, so a cell is as tall as it is wide in metres and one pad serves both axes
    const worstLat = Math.max(Math.abs(a.lat), Math.abs(b.lat), Math.abs(lat0));
    const pad = Math.ceil(h / (CELL_M_EQ * Math.cos(worstLat * RAD))) + 1;
    const ca = lngLatToCell(a.lon, a.lat), cb = lngLatToCell(b.lon, b.lat);
    const x0 = Math.floor(Math.min(ca.cx, cb.cx)) - pad, x1 = Math.floor(Math.max(ca.cx, cb.cx)) + pad;
    const y0 = Math.max(0, Math.floor(Math.min(ca.cy, cb.cy)) - pad);
    const y1 = Math.min(WORLD_CELLS - 1, Math.floor(Math.max(ca.cy, cb.cy)) + pad);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const c = cellToLngLat(cx + 0.5, cy + 0.5);
        const px = c.lng * kx - ax, py = c.lat * ky - ay;
        const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        if (Math.hypot(px - u * dx, py - u * dy) <= h) {
          keys.push((((cx % WORLD_CELLS) + WORLD_CELLS) % WORLD_CELLS) * WORLD_CELLS + cy);
        }
      }
    }
  }

  // track: [{t (ms), lat, lon, accuracy?}] in recorded order -> Int32Array of [cx, cy] pairs, sorted by cx then cy, unique
  function reveal(track, rules) {
    rules = rules || RULES;
    checkRules(rules);
    const pts = [];
    for (const p of track) {
      if (!Number.isFinite(p.t) || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      if (p.accuracy > rules.maxAccuracyM) continue; // a missing accuracy keeps the point
      pts.push({ t: p.t, lat: clampLat(p.lat), lon: p.lon });
    }

    let keys = [];
    let flushAt = FLUSH_AT; // doubles past the unique cells so a big track is not re-sorted at every point
    const h = rules.halfWidthM;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      let joined = false, joinedBefore = false;
      if (b) joined = joins(a, b, rules);
      if (i > 0) joinedBefore = joins(pts[i - 1], a, rules);
      if (joined) addSegment(keys, a, b, h);
      else if (!joinedBefore) addSegment(keys, a, a, h);
      if (keys.length > flushAt) { keys = compact(keys); flushAt = Math.max(FLUSH_AT, keys.length * 2); }
    }

    keys = compact(keys);
    const out = new Int32Array(keys.length * 2);
    for (let i = 0; i < keys.length; i++) {
      out[2 * i] = Math.floor(keys[i] / WORLD_CELLS);
      out[2 * i + 1] = keys[i] % WORLD_CELLS;
    }
    return out;
  }

  // The time must run forward, within maxGapS; the distance within maxGapM; a longitude jump over 180 degrees is
  // an antimeridian crossing, which is a gap rather than a segment round the world.
  function joins(a, b, rules) {
    const dt = b.t - a.t;
    if (dt < 0 || dt > rules.maxGapS * 1000) return false;
    const dLon = Math.abs(b.lon - a.lon);
    if (dLon > 180) return false;
    const lat0 = (a.lat + b.lat) / 2;
    const dist = Math.hypot(dLon * RAD * R * Math.cos(lat0 * RAD), (b.lat - a.lat) * RAD * R);
    return dist <= rules.maxGapM;
  }

  global.Reveal = { RULES, reveal };
})(window);
