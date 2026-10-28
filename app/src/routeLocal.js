// routeWaypoints for the route tool: pins -> street tiles around each leg -> LocalRouter -> heights ->
// estimates. Nothing here talks to a routing service; the only requests are the street and elevation
// tile fetches the injected sources make.
(function (global) {
  const PAD_M = 1000;        // streets are fetched this far around each leg, so a detour past a pin has data
  const KY = 110540;         // metres per degree of latitude, as the planner uses
  const MAX_LEG_M = 30000;   // as Suggest's A-to-B cap: farther apart needs a street download past what we allow
  const NO_STREETS = { error: true, why: { reason: "no-street-data" } };
  const INTERNAL = { error: true, why: { reason: "internal" } };
  const SUPERSEDED = { error: true, why: { reason: "superseded" } };
  const TOO_FAR = { error: true, why: { reason: "too-far" } };
  let warnedHeights = false;

  function legM(a, b) {
    const kx = 111320 * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
    return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * KY);
  }

  // The padded rect of one leg: both pins plus PAD_M on every side.
  function legRect(a, b) {
    const s = Math.min(a.lat, b.lat), n = Math.max(a.lat, b.lat);
    const kx = 111320 * Math.cos(Math.max(Math.abs(s), Math.abs(n)) * Math.PI / 180);
    return {
      s: s - PAD_M / KY, n: n + PAD_M / KY,
      w: Math.min(a.lng, b.lng) - PAD_M / kx, e: Math.max(a.lng, b.lng) + PAD_M / kx,
    };
  }

  // streets: StreetIndex (ensureRects); plannerFor(travelMode) -> GraphPlanner|null; elevation:
  // {elevationAt}; estimates: Estimates; streetKind(travelMode) -> "run"|"bike".
  function create({ streets, plannerFor, elevation, estimates, streetKind }) {
    // points: [{lat, lng}] (at least two), travelMode as the mode buttons name it;
    // onProgress({done, total, waitUntil?}) hears the street download, if one is needed; stale()
    // true means a newer request replaced this one, so the download asks for nothing further.
    // -> {coords, stats: {km, seconds, ascent, descent}} or {error: true, why}
    return async function routeWaypoints(points, travelMode, onProgress, stale) {
      const rects = [];
      for (let i = 1; i < points.length; i++) {
        if (legM(points[i - 1], points[i]) > MAX_LEG_M) return TOO_FAR;
        rects.push(legRect(points[i - 1], points[i]));
      }
      // a failed download logs its reason, a bug its class, never a message: messages name tiles
      try { await streets.ensureRects(rects, streetKind(travelMode), { onProgress, stale, holdAs: "route" }); } catch (e) {
        if (global.StreetIndex.isSuperseded(e)) return SUPERSEDED; // replaced by a newer request, which _recalc ignores; nothing to log
        // a bug is logged even when the request is stale: staleness only keeps it from being shown
        if (!global.StreetIndex.isDownloadError(e)) {
          console.error("[route] reading streets threw", e && e.name);
          return stale && stale() ? SUPERSEDED : INTERNAL;
        }
        if (stale && stale()) return SUPERSEDED; // a download failure nobody will see
        console.warn("[route] streets unavailable", e.reason);
        return { error: true, why: { reason: "streets-fetch", download: global.StreetIndex.downloadFacts(e) } };
      }
      const planner = plannerFor(travelMode);
      if (!planner) return NO_STREETS;
      const router = new global.LocalRouter(planner);
      const route = router.route(points);
      if (!route) return { error: true, why: router.explain(points) };

      // a failed height lookup leaves the line without heights rather than failing the route
      let heights;
      try { heights = await elevation.elevationAt(route.coords); } catch (e) {
        // tile failures are warned inside the elevation source; this is anything else, once
        if (!warnedHeights) { warnedHeights = true; console.warn("[route] heights unavailable", e && e.name); }
        heights = [];
      }
      const est = estimates.estimate(route.coords, travelMode, heights);
      // no height arrived at all: a 2D line and unknown climb, not a profile that claims flat ground
      const known = est.elevationKnown > 0;
      return {
        coords: known ? est.coords : route.coords,
        stats: {
          km: est.distanceM / 1000,
          seconds: est.seconds,
          ascent: known ? est.ascentM : null,
          descent: known ? est.descentM : null,
        },
      };
    };
  }

  global.RouteLocal = { create };
})(window);
