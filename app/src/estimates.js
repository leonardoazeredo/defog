// Distance, filtered ascent and travel time for a routed line, ported from BRouter (MIT, see
// mobile/licenses/brouter-LICENSE.txt): CheapRuler, RoutingEngine.recalcTrack, StdPath.computeKinematic.
// Arithmetic follows BRouter's int and float steps; bench/estimates.test.js holds the figures against its
// recorded answers. Ascent differs by the filter choice noted at DEFAULT_ASCENT_FILTER_M.
(function (global) {
  const SCALE_BUCKET = 100000; // ilat span of one cached cosine series
  const SCALE_BUCKETS = 1800;
  const GRAVITY = 9.81;
  // BRouter picks 5 or 10 per node by its own elevation data (RoutingEngine.elevationFilter), which the phone
  // cannot know; 10 had half the mean ascent error of 5 over the local cache (see bench/estimates-cache.test.js)
  const DEFAULT_ASCENT_FILTER_M = 10;

  const FOOT = { kind: "foot", maxSpeed: 6 / 3.6 };
  // RoutingContext's defaults, which the trekking and fastbike profiles keep
  const BIKE = { kind: "bike", maxSpeed: 45 / 3.6, totalMass: 90, sCx: 0.225, rollResistance: 0.01, bikerPower: 100 };
  const MODES = { trekking: BIKE, fastbike: BIKE, "hiking-mountain": FOOT, shortest: FOOT };

  const scaleCache = [];
  function scalesAt(ilat) {
    const i = Math.min(SCALE_BUCKETS - 1, Math.max(0, Math.floor(ilat / SCALE_BUCKET)));
    if (!scaleCache[i]) {
      // Chebyshev recurrence for cos(2x)..cos(5x), as CheapRuler does
      const cos = Math.cos(((i * SCALE_BUCKET + SCALE_BUCKET / 2) * 1e-6 - 90) * (Math.PI / 180));
      const cos2 = 2 * cos * cos - 1;
      const cos3 = 2 * cos * cos2 - cos;
      const cos4 = 2 * cos * cos3 - cos2;
      const cos5 = 2 * cos * cos4 - cos3;
      scaleCache[i] = [
        (111.41513 * cos - 0.09455 * cos3 + 0.00012 * cos5) * 1e-3,
        (111.13209 - 0.56605 * cos2 + 0.0012 * cos4) * 1e-3,
      ];
    }
    return scaleCache[i];
  }

  const toIlon = (lon) => Math.round((lon + 180) * 1e6);
  const toIlat = (lat) => Math.round((lat + 90) * 1e6);

  // metres between two [lon, lat] points, rounded and at least 1 like OsmPathElement.calcDistance
  function distanceM(a, b) {
    const ilon1 = toIlon(a[0]), ilat1 = toIlat(a[1]), ilon2 = toIlon(b[0]), ilat2 = toIlat(b[1]);
    const [kx, ky] = scalesAt(Math.floor((ilat1 + ilat2) / 2));
    return Math.max(1, Math.round(Math.hypot((ilon1 - ilon2) * kx, (ilat1 - ilat2) * ky)));
  }

  // a missing height takes the previous one (a flat stretch); leading gaps take the first known one,
  // so a failed tile at the start does not read as a climb from sea level
  function fillHeights(n, elevation) {
    const out = new Array(n);
    let first = 0;
    for (let i = 0; i < n; i++) {
      const v = elevation && elevation[i];
      if (Number.isFinite(v)) { first = v; break; }
    }
    let prev = first;
    for (let i = 0; i < n; i++) {
      const v = elevation && elevation[i];
      prev = Number.isFinite(v) ? v : prev;
      out[i] = prev;
    }
    return out;
  }

  // RoutingEngine.recalcTrack: a climb counts at once, a descent is held back (down to -filter) and
  // cancels the next climbs, so surveying noise does not add up to ascent
  function filteredClimb(heights, filterM) {
    let total = 0;
    let buffer = 0;
    for (let i = 1; i < heights.length; i++) {
      buffer += heights[i] - heights[i - 1];
      if (buffer > 0) { total += buffer; buffer = 0; }
      else if (buffer < -filterM) buffer = -filterM;
    }
    return Math.trunc(total);
  }

  // StdPath.solveCubic: the speed at which a * v^3 + c * v = d, by Newton's method
  // (start 8 m/s, doubled while the cubic's value minus d is below 0.1; BRouter's 10 iterations are kept)
  function solveCubic(a, c, d) {
    let v = 8;
    let findingStart = true;
    for (let i = 0; i < 10; i++) {
      const y = (a * v * v + c) * v - d;
      if (y < 0.1) {
        if (findingStart) { v *= 2; continue; }
        break;
      }
      findingStart = false;
      v -= y / (3 * a * v * v + c);
    }
    return v;
  }

  // StdPath.computeKinematic over every link; the buffer and the running time are floats in BRouter
  function travelSeconds(links, heights, mode) {
    const f32 = Math.fround;
    let buffer = 0;
    let total = 0;
    for (let i = 0; i < links.length; i++) {
      const dist = links[i];
      buffer = f32(buffer + (heights[i + 1] - heights[i]));
      // calcIncline: the buffer decays by exp(-d/100): toward 0 inside +-3 m, toward the band edge outside it, so smoothing spans about 100 m
      const shift = buffer > 3 ? -3 : buffer < -3 ? 3 : 0;
      const next = f32((buffer + shift) * Math.exp(-dist / 100) - shift);
      const incline = (buffer - next) / dist;
      buffer = next;

      let speed = mode.maxSpeed;
      if (mode.kind === "foot") {
        // Tobler's hiking function
        speed = mode.maxSpeed * Math.exp(-3.5 * Math.abs(incline + 0.05));
      } else if (mode.kind === "bike") {
        const roll = mode.totalMass * GRAVITY * (mode.rollResistance + incline);
        speed = Math.min(solveCubic(mode.sCx, roll, mode.bikerPower), mode.maxSpeed);
      }
      total = f32(total + f32(dist / speed));
    }
    return total;
  }

  // coords: [[lon, lat]]; elevation: metres per point, null where unknown.
  // opts.ascentFilterM overrides the default buffer.
  // A travel mode without a model gets distance and heights but `seconds: null`.
  function estimate(coords, travelMode, elevation, opts) {
    const pts = Array.isArray(coords) ? coords : [];
    // one NaN would turn every total into NaN, which serialises as null and reads as "no model"
    if (!pts.every((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))) throw new TypeError("estimate: every point needs a finite lon and lat");
    const heights = fillHeights(pts.length, elevation);
    const known = pts.reduce((n, _, i) => n + (Number.isFinite(elevation && elevation[i]) ? 1 : 0), 0);
    const filterM = (opts && opts.ascentFilterM) ?? DEFAULT_ASCENT_FILTER_M;
    const links = [];
    let distance = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = distanceM(pts[i - 1], pts[i]);
      links.push(d);
      distance += d;
    }
    const mode = Object.hasOwn(MODES, travelMode) ? MODES[travelMode] : null;
    return {
      coords: pts.map((p, i) => [p[0], p[1], heights[i]]),
      distanceM: distance,
      seconds: mode ? Math.round(travelSeconds(links, heights, mode)) : null,
      ascentM: filteredClimb(heights, filterM),
      descentM: filteredClimb(heights.map((h) => -h), filterM),
      // callers cannot otherwise tell flat ground from heights that never arrived
      elevationKnown: known,
    };
  }

  global.Estimates = { estimate, distanceM, MODES };
})(window);
