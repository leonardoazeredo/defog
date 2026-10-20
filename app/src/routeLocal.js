// routeWaypoints for the route tool: pins -> street tiles around each leg -> LocalRouter -> heights ->
// estimates. Nothing here talks to a routing service; the only requests are the street and elevation
// tile fetches the injected sources make.
(function (global) {
  const PAD_M = 1000;        // streets are fetched this far around each leg, so a detour past a pin has data
  const KY = 110540;         // metres per degree of latitude, as the planner uses
  const NO_STREETS = { error: true, why: { reason: "no-street-data" } };

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
  // {elevationAt}; estimates: Estimates; streetKind(travelMode) -> "run"|"bike"|"car".
  function create({ streets, plannerFor, elevation, estimates, streetKind }) {
    // points: [{lat, lng}] (at least two), travelMode as the mode buttons name it.
    // -> {coords, stats: {km, seconds, ascent, descent}} or {error: true, why}
    return async function routeWaypoints(points, travelMode) {
      const rects = [];
      for (let i = 1; i < points.length; i++) rects.push(legRect(points[i - 1], points[i]));
      try { await streets.ensureRects(rects, streetKind(travelMode)); } catch (e) { return NO_STREETS; }
      const planner = plannerFor(travelMode);
      if (!planner) return NO_STREETS;
      const router = new global.LocalRouter(planner);
      const route = router.route(points);
      if (!route) return { error: true, why: router.explain(points) };

      // a failed height lookup leaves the line without heights rather than failing the route
      let heights;
      try { heights = await elevation.elevationAt(route.coords); } catch (e) { heights = []; }
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
