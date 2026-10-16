// "Surprise me" routing: suggest up to 3 routes that maximise defogging.
// Two modes: point-to-point (A → B) and loop (start + target distance).
// Candidates are routed locally over the street graph (fog-seeking via-points /
// fog-biased loop bearings, plus the graph planner's walks) and every candidate is
// scored client-side with the caller's defog-gain function. The fog itself never
// leaves the device; only the bounding box of the streets needed goes to Overpass.
(function (global) {
  const DEFAULT_BUFFER = 0.15;  // p2p: max length over the fastest route, or ± around a wanted distance; loop: tolerance around target
  const MAX_VIAS = 6;           // fog-seeking detour candidates per p2p run
  const VIA_RETRIES = 2;        // times a via is pulled back in when its route overshoots
  const RETRACE_WEIGHT = 0.5;   // p2p: share of a route's score lost if all of it retraces itself
  const RETRACE_REROUTE_MIN = 0.12; // p2p: retraced share above which a via route's return leg is re-asked
  const MAX_RETRACE_REROUTES = 2;   // re-routed return legs per run
  const MAX_P2P_M = 30000;      // A and B farther apart than this need a street download past what we cap
  const MAX_LOOP_M = 30000;     // longer loops reach past the capped street download (bearing squares reach ~0.3x the length)
  const MAX_LOOPS = 6;          // loop bearings tried per run
  const CONCURRENCY = 3;        // jobs interleaved by the pool
  // Same neon family as the drawn route (#ff2d55): red · pink · orange, which pops against
  // the fog, deliberately far from the blue/purple/slate fog swatches.
  const COLORS = ["#ff2d55", "#ff4fa3", "#ff8c2d"];

  function pinIcon(cls, label) {
    const COARSE = !!(global.matchMedia && global.matchMedia("(pointer: coarse)").matches);
    const sz = COARSE ? 26 : 18;
    return L.divIcon({ className: "", html: '<div class="wp ' + cls + '">' + label + "</div>", iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
  }

  function SuggestTool(map, opts) {
    this.map = map;
    this.fogMap = opts.fogMap;
    this.computeGain = opts.computeGain;   // (coords) -> { area, newPct } | null
    this.isNew = opts.isNew || null;       // (lon,lat) -> true if the point is new ground
    this.streets = opts.streets || null;   // StreetIndex; candidates chase undefogged streets
    this.onPoints = opts.onPoints || null; // (count) -> UI update
    this.onResults = opts.onResults || null; // (state|null) -> render progress/cards
    this.mode = "p2p";                     // "p2p" | "loop"
    this.a = null; this.b = null;          // start / end markers (loop uses only a)
    this.active = false;
    this.results = [];                     // top candidates of the last run
    this.lines = [];                       // their preview polylines
    this.selected = -1;
    this._runId = 0;
    this._planners = {};                   // profile -> GraphPlanner
    this._onClick = (e) => this._place(e.latlng);
  }

  SuggestTool.prototype.setActive = function (on) {
    this.active = on;
    if (on) this.map.on("click", this._onClick);
    else this.map.off("click", this._onClick);
    this.map.getContainer().style.cursor = on ? "crosshair" : "";
  };

  SuggestTool.prototype.setMode = function (m) {
    if (this.mode === m) return;
    this.mode = m;
    if (m === "loop" && this.b) { this.map.removeLayer(this.b); this.b = null; }
    this.clearResults();
    if (this.onPoints) this.onPoints(this.pointCount());
  };

  SuggestTool.prototype.pointCount = function () { return (this.a ? 1 : 0) + (this.b ? 1 : 0); };
  SuggestTool.prototype.pointsNeeded = function () { return this.mode === "loop" ? 1 : 2; };

  SuggestTool.prototype._place = function (latlng) {
    if (this.a && (this.mode === "loop" || this.b)) return; // all pins set, drag to adjust
    const isA = !this.a;
    const m = L.marker(latlng, { draggable: true, icon: pinIcon(isA ? "sugA" : "sugB", isA ? "A" : "B") }).addTo(this.map);
    m.on("dragend", () => this.clearResults());
    m.on("click", (e) => { L.DomEvent.stop(e); this._removePin(m); });
    if (isA) this.a = m; else this.b = m;
    this.clearResults();
    if (this.onPoints) this.onPoints(this.pointCount());
  };

  SuggestTool.prototype._removePin = function (m) {
    this.map.removeLayer(m);
    if (this.a === m) this.a = null; else if (this.b === m) this.b = null;
    this.clearResults();
    if (this.onPoints) this.onPoints(this.pointCount());
  };

  SuggestTool.prototype.reset = function () {
    if (this.a) this.map.removeLayer(this.a);
    if (this.b) this.map.removeLayer(this.b);
    this.a = this.b = null;
    this.clearResults();
    if (this.onPoints) this.onPoints(0);
  };

  SuggestTool.prototype.clearResults = function () {
    this._runId++; // cancels any in-flight run
    this.lines.forEach((l) => { this.map.removeLayer(l.solid); this.map.removeLayer(l.dashed); });
    this.lines = []; this.results = []; this.selected = -1;
    if (this.onResults) this.onResults(null);
  };

  SuggestTool.prototype.select = function (i) {
    this.selected = i;
    this.lines.forEach((l, k) => {
      const sel = k === i;
      l.solid.setStyle({ weight: sel ? 6 : 4, opacity: sel ? 0.95 : 0.65 });
      l.dashed.setStyle({ weight: sel ? 4.5 : 3, opacity: sel ? 0.9 : 0.55 });
    });
  };

  // Same split as the drawn route: solid runs where the route breaks new ground,
  // dashed ("hatched") runs where it crosses ground that's already defogged.
  function splitRuns(coords, isNew) {
    const newRuns = [], oldRuns = [];
    let cur = null, run = null;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const isN = isNew ? isNew((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) : true;
      if (cur === null) { cur = isN; run = [[a[1], a[0]]]; }
      else if (isN !== cur) { (cur ? newRuns : oldRuns).push(run); cur = isN; run = [[a[1], a[0]]]; }
      run.push([b[1], b[0]]);
    }
    if (run) (cur ? newRuns : oldRuns).push(run);
    return { newRuns, oldRuns };
  }

  // Candidate i for the ordinary route editor: the pins to show and the exact
  // geometry that was previewed.
  SuggestTool.prototype.adopt = function (i) {
    const c = this.results[i];
    if (!c) return null;
    const out = { wps: c.adoptWps.slice(), coords: c.r.coords };
    this.clearResults();
    return out;
  };

  // ----- shared plumbing --------------------------------------------------------

  // Local shortest path through the points over the street graph for the profile;
  // null when there is no street data, a point is off the network, or no path exists.
  // opts.avoid: Set of graph edge ids to discourage (a leg's `edges`).
  SuggestTool.prototype._route = async function (latlngs, profile, opts) {
    const planner = this._getPlanner(profile);
    return planner ? new global.LocalRouter(planner).route(latlngs, opts) : null;
  };

  // Explained so the error can name the pin or pieces that failed, not just fail.
  SuggestTool.prototype._noRoute = function (latlngs, profile) {
    const planner = this._getPlanner(profile);
    if (!planner) return { error: true, reason: "no-street-data" };
    const why = new global.LocalRouter(planner).explain(latlngs);
    return { error: true, reason: why.reason || "no-path", why };
  };

  // Re-ask the leg after the via with the outbound streets avoided. null means keep the
  // original: not a via route, no way home routed, or the way home is the same.
  // The caller decides whether the new way home is worth taking.
  SuggestTool.prototype._rerouteReturn = async function (route, via, B, profile) {
    if (route.legs.length !== 2) return null;
    const [out, home] = route.legs;
    const back = await this._route([via, B], profile, { avoid: new Set(out.edges) });
    if (!back || !back.coords.length) return null;
    // the new route also starts with a stub from the via pin, so compare tails
    const tail = back.coords.slice(-home.coords.length);
    if (tail.length === home.coords.length && tail.every((p, i) => p[0] === home.coords[i][0] && p[1] === home.coords[i][1])) return null;
    return statsFromCoords(out.coords.concat(back.coords.slice(1)));
  };

  // Share of never-visited cells within ~100 m of a point, used to steer candidates
  // away from ground the user has already covered.
  SuggestTool.prototype._newness = function (latlng) {
    if (!this.fogMap.tileCount) return 1;
    const cellM = (40075016.686 / FogParser.WORLD_CELLS) * Math.cos(latlng.lat * Math.PI / 180);
    const r = Math.min(15, Math.max(2, Math.round(100 / cellM)));
    const c = FogParser.lngLatToCell(latlng.lng, latlng.lat);
    const cx0 = Math.floor(c.cx), cy0 = Math.floor(c.cy);
    let visited = 0, total = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      total++;
      if (this.fogMap.isVisitedCell(cx0 + dx, cy0 + dy)) visited++;
    }
    return 1 - visited / total;
  };

  // How much of one route runs along another, used to drop near-duplicates
  // (e.g. a via candidate that snapped onto the same roads as a planned
  // route) and to keep the three shown routes from sharing a corridor.
  // Routes are walked in fixed metre steps rather than by point index, so the
  // answer doesn't depend on how densely the route's coordinates are sampled, and
  // one route's path is stamped into a grid of NEAR_CELL squares and the other
  // is counted as alongside it wherever it lands within NEAR_PAD squares of a
  // stamped one. "Runs along" therefore means "within about 30 m", and
  // comparing two routes costs one walk of each rather than a test of every
  // segment against every other segment.
  const NEAR_CELL = 15;      // metres per grid square
  const NEAR_PAD = 2;        // squares of slack allowed when matching
  const SAME_ROUTE = 0.9;    // above this share it's the same route again, never show it
  const SAME_CORRIDOR = 0.6; // above this it's the same way there, show it only to fill a slot

  // Call fn(x, y, lenM) at the midpoint of every stepM-long piece of the route,
  // in a local metric frame.
  function walk(coords, kx, ky, stepM, fn) {
    for (let i = 1; i < coords.length; i++) {
      const ax = coords[i - 1][0] * kx, ay = coords[i - 1][1] * ky;
      const bx = coords[i][0] * kx, by = coords[i][1] * ky;
      const d = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(d / stepM));
      for (let k = 0; k < n; k++)
        fn(ax + (bx - ax) * (k + 0.5) / n, ay + (by - ay) * (k + 0.5) / n, d / n);
    }
  }

  // The grid squares a route passes through.
  function footprint(coords, kx, ky) {
    const cells = new Set();
    walk(coords, kx, ky, NEAR_CELL, (x, y) =>
      cells.add(Math.round(x / NEAR_CELL) + "," + Math.round(y / NEAR_CELL)));
    return cells;
  }

  function nearCells(cells, x, y) {
    const cx = Math.round(x / NEAR_CELL), cy = Math.round(y / NEAR_CELL);
    for (let dx = -NEAR_PAD; dx <= NEAR_PAD; dx++)
      for (let dy = -NEAR_PAD; dy <= NEAR_PAD; dy++)
        if (cells.has((cx + dx) + "," + (cy + dy))) return true;
    return false;
  }

  // Share of this route's length (0..1) that runs alongside the footprint.
  // Deliberately one-directional: the question is how much of THIS route the
  // reader has already seen, so a short route inside a long one scores high,
  // while a long route that merely contains a short one does not.
  function sharedFrac(coords, cells, kx, ky) {
    let total = 0, shared = 0;
    walk(coords, kx, ky, NEAR_CELL, (x, y, len) => {
      total += len;
      if (nearCells(cells, x, y)) shared += len;
    });
    return total ? shared / total : 0;
  }

  // deg -> local metres around a latitude
  function metresPerDeg(lat) {
    return { kx: 111320 * Math.cos(lat * Math.PI / 180), ky: 110540 };
  }

  // Which street classes matter: on foot everything walkable, on wheels not
  // footways/paths (also keeps the bigger bike-range downloads sane).
  function streetKind(profile) { return profile === "hiking-mountain" ? "run" : "bike"; }

  // Make sure the streets for the rects are loaded. Resolves false once the run is over:
  // stale, or the error state was emitted because the download failed.
  SuggestTool.prototype._loadStreets = async function (rects, profile, emit, stale) {
    const kind = streetKind(profile);
    // only announce a fetch when one will really happen; a rerun in the same
    // area is served from cache and shouldn't flash "reading the street map"
    if (this.streets.needsFetch(rects, kind)) emit({ loading: true, phase: "streets" });
    try { await this.streets.ensureRects(rects, kind); } catch (e) { emit({ error: true, reason: "streets-fetch", why: e.message }); return false; }
    return !stale();
  };

  // The street graph for a profile: it plans high-defog loops and walks and is
  // what routing runs on. One per profile, because each may use different ways;
  // built lazily, rebuilt only when new streets arrive.
  SuggestTool.prototype._getPlanner = function (profile) {
    if (!this.streets || !global.GraphPlanner || !this.streets.ways.length) return null;
    if (!this._planners[profile])
      this._planners[profile] = new global.GraphPlanner(this.streets, this.streets.newFrac, this.streets.usableFor(profile), this.streets.onewayFor(profile));
    return this._planners[profile];
  };

  // Defoggable area (m²) reachable via the ways within rM of the point, or
  // null where street data doesn't cover it. Null means: fall back to fog-only
  // scoring. Raw fog can't tell a street grid from a lake; this can, and it is
  // area-weighted so a lone path through virgin meadow scores what it's worth.
  SuggestTool.prototype._newAreaM2 = function (latlng, rM) {
    if (!this.streets || !this.streets.covered(latlng.lat, latlng.lng)) return null;
    return this.streets.newAreaM2(latlng, rM);
  };

  // Pull a generation via to the most undefogged-street-rich spot within reach,
  // so loops are born aimed at fogged streets instead of hoping a route
  // passes them. The current spot keeps a bias and distance discounts a candidate, so
  // the loop holds roughly its intended shape and length.
  SuggestTool.prototype._snapToNewStreets = function (ll, radiusM) {
    const base = this._newAreaM2(ll, 200);
    if (base === null || radiusM < 200) return ll;
    const { kx, ky } = metresPerDeg(ll.lat);
    // gentle keep-bias: in dense areas scores are high everywhere, so a strong
    // bias (tried 1.15) freezes every via in place and the snapping no-ops
    let best = ll, bs = base * 1.05 + 600;
    const step = Math.max(150, radiusM / 3);
    for (let dy = -radiusM; dy <= radiusM; dy += step) {
      for (let dx = -radiusM; dx <= radiusM; dx += step) {
        if (!dx && !dy) continue;
        const p = L.latLng(ll.lat + dy / ky, ll.lng + dx / kx);
        const m = this._newAreaM2(p, 200);
        if (m === null) continue;
        const s = m * (1 - Math.hypot(dx, dy) / (radiusM * 2.2));
        if (s > bs) { bs = s; best = p; }
      }
    }
    return best;
  };

  // Run jobs (thunks returning a promise) through a small worker pool, reporting progress.
  // Routing is synchronous, so each job waits a turn first to let the page repaint.
  SuggestTool.prototype._pool = async function (jobs, stale, onTick) {
    const out = [];
    let next = 0, done = 0;
    const worker = async () => {
      while (next < jobs.length && !stale()) {
        const j = jobs[next++];
        await new Promise((res) => setTimeout(res));
        if (stale()) return;
        const r = await j();
        if (stale()) return;
        done++;
        onTick(done);
        if (r) out.push(r);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    return out;
  };

  // Show three routes that go different ways rather than three variations on
  // one. Loops are separated by direction: a candidate is taken only if no
  // already-taken loop heads within 60 degrees of it (heading = start pin to
  // the loop's farthest point). Angular distance, so headings either side of
  // due north (350 and 10 degrees) count as the same direction. A→B has a
  // fixed direction, so those are separated by ground instead: a candidate is
  // taken only if less than SAME_CORRIDOR of its length runs along a route
  // already taken, which catches the real failure, two routes sharing a middle.
  // Whatever either rule defers is appended best-first, so where the geography
  // offers only one or two ways (water, a dead end, one bridge) the deck still
  // fills and this never invents variety that isn't there.
  SuggestTool.prototype._diversify = function (ranked, extra, kx, ky) {
    if (ranked.length <= 2) return ranked;
    const loop = extra.targetKm != null;
    if (loop && !this.a) return ranked;
    let differs;
    if (loop) {
      const S = this.a.getLatLng();
      const bearing = (c) => {
        let far = c.r.coords[0], fd = -1;
        for (const p of c.r.coords) {
          const d = (p[1] - S.lat) * (p[1] - S.lat) + (p[0] - S.lng) * (p[0] - S.lng);
          if (d > fd) { fd = d; far = p; }
        }
        return (((Math.atan2(far[0] - S.lng, far[1] - S.lat) * 180 / Math.PI) + 360) % 360);
      };
      const apart = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
      for (const c of ranked) c._brg = bearing(c);
      differs = (c, taken) => taken.every((o) => apart(o._brg, c._brg) > 60);
    } else {
      differs = (c, taken) => taken.every((o) => sharedFrac(c.r.coords, o.cells, kx, ky) < SAME_CORRIDOR);
    }
    const picked = [], rest = [];
    for (const c of ranked) (differs(c, picked) ? picked : rest).push(c);
    return picked.concat(rest);
  };

  // Score, dedupe, rank and present the top 3 of a run.
  SuggestTool.prototype._finish = function (runId, cands, extra) {
    if (runId !== this._runId) return;
    const emit = (s) => { if (this.onResults) this.onResults(s); };
    if (!cands.length) { emit(Object.assign({ empty: true }, extra)); return; }
    // Score first, rank, THEN dedupe, because near-identical routes must collapse onto the
    // best-gaining of the pair, not whichever happened to be scored first.
    let scored = cands.map((c) => Object.assign({
      gain: this.computeGain(c.r.coords) || { area: 0, newPct: 0 }
    }, c));
    // a route that breaks <1% new ground isn't a suggestion, it's a re-walk
    scored = scored.filter((c) => c.gain.area > 0 && c.gain.newPct >= 1);
    if (!scored.length) { emit(Object.assign({ empty: true, reason: "defogged" }, extra)); return; }
    // A to B also loses up to RETRACE_WEIGHT of its score in proportion to the share it
    // retraces (rankKey); loops use the plain key below.
    // rank by area, blended with share-of-length-on-new-ground: between two
    // routes that defog the same area, the one that isn't mostly a re-walk wins
    const key = extra.baseKm != null
      ? (c) => { c.retrace = overlapFrac(c.r.coords, false); return rankKey(c.gain, c.retrace); }
      : (c) => c.gain.area * (0.7 + 0.3 * Math.min(1, c.gain.newPct / 100));
    for (const c of scored) c.key = key(c);
    scored.sort((x, y) => y.key - x.key);
    // One local metric frame for the whole run, so footprints are comparable.
    const { kx, ky } = metresPerDeg(scored[0].r.coords[0][1]);
    const unique = [];
    for (const c of scored) {
      if (unique.some((o) => sharedFrac(c.r.coords, o.cells, kx, ky) > SAME_ROUTE)) continue;
      c.cells = footprint(c.r.coords, kx, ky);
      unique.push(c);
    }
    this.results = this._diversify(unique, extra, kx, ky).slice(0, 3);

    this.lines = this.results.map((c, i) => {
      const runs = splitRuns(c.r.coords, this.isNew);
      return {
        solid: L.polyline(runs.newRuns, { color: COLORS[i], weight: 4, opacity: 0.65 }).addTo(this.map),
        dashed: L.polyline(runs.oldRuns, { color: COLORS[i], weight: 3, opacity: 0.55, dashArray: "2 8", lineCap: "round" }).addTo(this.map)
      };
    });
    if (this.lines.length) {
      let bounds = null;
      this.results.forEach((c) => c.r.coords.forEach((p) => {
        bounds = bounds ? bounds.extend([p[1], p[0]]) : L.latLngBounds([p[1], p[0]], [p[1], p[0]]);
      }));
      this.map.fitBounds(bounds, { padding: [30, 30] });
      this.select(0); // best option pre-selected before the cards render
    }
    const refKm = extra.baseKm != null ? extra.baseKm : extra.targetKm;
    emit(Object.assign({}, extra, {
      list: this.results.map((c, i) => ({
        color: COLORS[i],
        km: c.r.lenM / 1000,
        deltaKm: c.r.lenM / 1000 - refKm,
        ascent: c.r.ascent, descent: c.r.descent,
        area: c.gain.area, newPct: c.gain.newPct,
        retracePct: c.retrace != null ? Math.round(c.retrace * 100) : undefined,
        isBase: !!c.isBase
      }))
    }));
  };

  SuggestTool.prototype.suggest = function (profile, o) {
    o = o || {};
    const buffer = o.buffer || DEFAULT_BUFFER;
    if (this.mode === "loop") return this._suggestLoop(profile, o.distM, buffer);
    return this._suggestP2P(profile, buffer, o.targetM);
  };

  // ----- point-to-point ---------------------------------------------------------

  // Largest perpendicular offset at fraction t along A→B whose straight-line via-path still
  // fits the budget (a lower bound on the routed length, so a safe outer limit).
  function dmax(t, L, budget) {
    let lo = 0, hi = budget;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (Math.hypot(t * L, mid) + Math.hypot((1 - t) * L, mid) <= budget) lo = mid; else hi = mid;
    }
    return lo;
  }

  // Point at fraction t along A→B, offset d metres perpendicular on the given side.
  SuggestTool.prototype._viaPoint = function (t, side, d) {
    const A = this.a.getLatLng(), B = this.b.getLatLng();
    const { kx, ky } = metresPerDeg((A.lat + B.lat) / 2);
    const ax = A.lng * kx, ay = A.lat * ky, bx = B.lng * kx, by = B.lat * ky;
    const L2 = Math.hypot(bx - ax, by - ay);
    if (L2 < 100) return null;
    const px = -(by - ay) / L2, py = (bx - ax) / L2;
    return L.latLng((ay + (by - ay) * t + py * side * d) / ky, (ax + (bx - ax) * t + px * side * d) / kx);
  };

  SuggestTool.prototype._viaCandidates = function (budgetM) {
    const A = this.a.getLatLng(), B = this.b.getLatLng();
    const { kx, ky } = metresPerDeg((A.lat + B.lat) / 2);
    const L2 = Math.hypot((B.lng - A.lng) * kx, (B.lat - A.lat) * ky);
    if (L2 < 100) return [];
    const cands = [];
    for (const t of [0.3, 0.5, 0.7]) {
      // 0.85: real roads are longer than the straight-line bound, so aim inside it
      const dm = dmax(t, L2, budgetM) * 0.85;
      for (const side of [1, -1]) {
        for (const scale of [1, 0.5]) { // full and medium detours at every station
          const d = dm * scale;
          if (d < 150) continue; // not a meaningful detour
          const ll = this._viaPoint(t, side, d);
          cands.push({ latlng: ll, scale, t, side, d });
        }
      }
    }
    return cands;
  };

  // Rank via candidates by defoggable area via ways within 350 m when street
  // data covers them all, by fog newness otherwise.
  // Rank within each detour size, then take half from each. Far offsets always
  // look richer but often route over the length budget; medium ones fit reliably, and
  // ranking them together would fill every MAX_VIAS slot from the far side.
  SuggestTool.prototype._pickVias = function (cands) {
    for (const c of cands) {
      c.areaM2 = this._newAreaM2(c.latlng, 350);
      if (c.areaM2 === null) c.newness = this._newness(c.latlng);
    }
    const street = cands.length > 0 && cands.every((c) => c.areaM2 !== null);
    // floors: below ~2000 m² reachable (or 5% new fog) a detour is too thin to be worth a candidate slot
    const ok = (c) => (street ? c.areaM2 >= 2000 : c.newness >= 0.05);
    const val = (c) => (street ? c.areaM2 : c.newness);
    const rank = (sc) => cands.filter((c) => c.scale === sc && ok(c))
      .sort((a, b) => val(b) - val(a));
    const full = rank(1), med = rank(0.5);
    const take = Math.ceil(MAX_VIAS / 2);
    const picked = full.slice(0, take).concat(med.slice(0, take));
    // top up from whichever side has leftovers if the other ran short
    for (const c of full.slice(take).concat(med.slice(take)))
      if (picked.length < MAX_VIAS) picked.push(c);
    return picked.slice(0, MAX_VIAS);
  };

  // The length window of an A to B run. With a wanted distance it is want ± buffer, never
  // below the fastest route; one shorter than that is clamped up to it and reported as such.
  function p2pWindow(baseM, targetM, buffer) {
    const want = targetM > 0 ? Math.max(targetM, baseM) : null;
    const clamped = want != null && targetM < baseM;
    const budget = (want || baseM) * (1 + buffer);
    const floor = want ? Math.max(baseM, want * (1 - buffer)) : 0;
    // where re-aimed vias should land: the wanted length, but no closer than halfway into
    // the buffer above the fastest route, so a clamped target doesn't aim at the fastest
    // route itself. With no wanted distance, just inside the budget: the best detours live
    // right at the edge.
    const aim = want ? Math.max(want, baseM * (1 + buffer / 2)) : baseM + 0.95 * (budget - baseM);
    return { want, clamped, budget, floor, aim };
  }

  // Candidates worth ranking. The fastest route is a normal candidate unless a wanted
  // distance puts it under the floor; then it only shows (fallback) when nothing else fits.
  function p2pCandidates(found, base, win) {
    const list = found.filter((c) => c.r.lenM >= win.floor);
    const baseFits = base.r.lenM >= win.floor;
    if (!win.want || baseFits || !list.length) list.unshift(base);
    return { list, fallback: win.want != null && !baseFits && list.length === 1 && list[0] === base };
  }

  SuggestTool.prototype._suggestP2P = async function (profile, buffer, targetM) {
    if (!this.a || !this.b) return;
    this.clearResults();
    const runId = this._runId;
    const stale = () => runId !== this._runId;
    const emit = (s) => { if (!stale() && this.onResults) this.onResults(s); };
    const A = this.a.getLatLng(), B = this.b.getLatLng();
    const bufferPct = Math.round(buffer * 100);

    emit({ loading: true, phase: "baseline" });
    if (!this.streets) { emit({ error: true, reason: "no-street-data" }); return; }

    // Streets first: routing runs on them. The budget isn't known until A to B is
    // routed, so size the box for a fastest route up to 1.5x the straight line and
    // pad it by how far sideways the longest allowed detour can reach.
    const { kx, ky } = metresPerDeg((A.lat + B.lat) / 2);
    const straightM = Math.hypot((B.lng - A.lng) * kx, (B.lat - A.lat) * ky);
    if (straightM > MAX_P2P_M) { emit({ empty: true, reason: "too-far", maxKm: MAX_P2P_M / 1000 }); return; }
    const reachM = Math.max(targetM || 0, straightM * 1.5) * (1 + buffer);
    const pad = Math.min(4000, Math.sqrt(Math.max(0, reachM * reachM - straightM * straightM)) / 2 + 300);
    // pins snapped to the cache grid (as for loops); the extra 400 m absorbs the snap offset
    const sa = this.streets.snapPoint(A), sb = this.streets.snapPoint(B), m = pad + 400;
    const rects = [{
      s: Math.min(sa.lat, sb.lat) - m / ky, n: Math.max(sa.lat, sb.lat) + m / ky,
      w: Math.min(sa.lng, sb.lng) - m / kx, e: Math.max(sa.lng, sb.lng) + m / kx
    }];
    if (!(await this._loadStreets(rects, profile, emit, stale))) return;

    const base = await this._route([A, B], profile);
    if (stale()) return;
    if (!base) { emit(this._noRoute([A, B], profile)); return; }
    const win = p2pWindow(base.lenM, targetM, buffer);
    const { want, clamped, budget, floor, aim } = win;
    const rawVias = this._viaCandidates(budget);

    // The graph planner proposes whole A-to-B walks through rewarding streets.
    // Skipped in mostly-virgin areas, where simple detours already defog near
    // the ceiling.
    let planned = [];
    if (budget <= 12000) {
      const planner = this._getPlanner(profile);
      if (planner) {
        const mid = L.latLng((A.lat + B.lat) / 2, (A.lng + B.lng) / 2);
        try {
          if (planner.meanFracNear(mid, Math.min(1800, budget * 0.25)) < 0.82)
            planned = planner.planP2P(A, B, budget, 3);
        } catch (e) {}
      }
    }

    let reroutes = 0;
    // candidate jobs: the planner's walks + our street/fog-seeking via-points
    const jobs = [];
    for (const pl of planned)
      jobs.push(async () => {
        const r = statsFromCoords(pl.coords);
        if (r.lenM > budget * 1.02) return null;
        const snip = snipOldSpurs(r.coords, this.computeGain, floor);
        if (snip.coords) return { r: statsFromCoords(snip.coords), adoptWps: [A].concat(resampleMids(snip.coords, 4), [B]) };
        return { r, adoptWps: pl.wps };
      });
    // planner plans ADD to the via candidates, they don't replace them: the
    // geometric vias are proven earners and cutting them for weaker plans
    // dropped p2p's best card. Trim only slightly to bound the run time.
    for (const v of this._pickVias(rawVias).slice(0, planned.length ? MAX_VIAS - 1 : MAX_VIAS))
      jobs.push(async () => {
        // Real streets inflate the straight-line ellipse the via was placed
        // inside, so a via route usually overshoots the budget. Pull the via
        // back toward the line and re-ask, up to VIA_RETRIES times, each time
        // rescaling from the length just measured rather than from the first
        // guess: one shot assumes routed length grows evenly with the offset,
        // and around a barrier like a river it doesn't. Where it did, every
        // detour overshot twice over and was binned, leaving only the plain
        // fastest route and the planner's walks.
        let ll = v.latlng, d = v.d;
        let r = await this._route([A, ll, B], profile);
        let best = r, bestLl = ll;
        for (let k = 0; k < VIA_RETRIES; k++) {
          // 3: past this the via is in the wrong place entirely, not just too far out
          if (!r || !r.lenM || r.lenM <= budget || r.lenM <= base.lenM || r.lenM > budget * 3) break;
          const shrink = Math.max(0.2, Math.min(0.9, (aim - base.lenM) / (r.lenM - base.lenM)));
          const d2 = d * shrink;
          const ll2 = d2 >= 120 ? this._viaPoint(v.t, v.side, d2) : null;
          if (!ll2) break;
          const r2 = await this._route([A, ll2, B], profile);
          if (!r2 || !r2.lenM) break;
          // pulling the via in usually shortens the route but not always, so keep
          // the shortest seen rather than the last: the loop stops at the first
          // one that fits, so that's the one this holds on to
          if (!best.lenM || r2.lenM < best.lenM) { best = r2; bestLl = ll2; }
          r = r2; ll = ll2; d = d2;
        }
        r = best; ll = bestLl;
        // a wanted distance also has a floor: one regrow pass when the via fell short of it
        if (want && r && r.lenM && r.lenM < floor && r.lenM > base.lenM) {
          const grow = Math.max(1.1, Math.min(3, (aim - base.lenM) / (r.lenM - base.lenM)));
          const ll2 = this._viaPoint(v.t, v.side, d * grow);
          const r2 = ll2 ? await this._route([A, ll2, B], profile) : null;
          if (r2 && r2.lenM && r2.lenM > r.lenM && r2.lenM <= budget * 1.02) { r = r2; ll = ll2; }
        }
        // 1.02: don't bin a route for skimming the budget by metres
        if (!r || !r.lenM || r.lenM > budget * 1.02) return null;
        let adoptWps = joinPins(r, A, B);
        const gainOf = (x) => this.computeGain(x.coords) || { area: 0, newPct: 0 };
        const retrace = overlapFrac(r.coords, false);
        if (retrace >= RETRACE_REROUTE_MIN && reroutes < MAX_RETRACE_REROUTES) {
          reroutes++;
          const rr = await this._rerouteReturn(r, ll, B, profile);
          if (stale()) return null;
          if (rr && rr.lenM >= floor && rr.lenM <= budget * 1.02 &&
              rankKey(gainOf(rr), overlapFrac(rr.coords, false)) > rankKey(gainOf(r), retrace)) {
            r = rr;
            // the editor can't avoid streets: pin the new way home with waypoints
            adoptWps = [A].concat(resampleMids(r.coords, Math.max(4, Math.min(8, Math.round(r.lenM / 500)))), [B]);
          }
        }
        const snip = snipOldSpurs(r.coords, this.computeGain, floor);
        if (snip.coords) return { r: statsFromCoords(snip.coords), adoptWps: [A].concat(resampleMids(snip.coords, 3), [B]) };
        return { r, adoptWps };
      });

    const total = jobs.length;
    emit({ loading: true, phase: "detours", done: 0, total });
    const found = await this._pool(jobs, stale, (done) => emit({ loading: true, phase: "detours", done, total }));
    if (stale()) return;
    const { list, fallback } = p2pCandidates(found, { r: base, adoptWps: [A, B], isBase: true }, win);
    this._finish(runId, list, {
      baseKm: base.lenM / 1000, bufferPct,
      wantKm: want ? want / 1000 : null, clamped, fallback
    });
  };

  // ----- loops ------------------------------------------------------------------

  // Scoring radius for a bearing sample: wide enough to see a neighbourhood,
  // scaled with the loop so long rides judge whole districts.
  function bearingRadius(distM) { return Math.min(800, Math.max(300, distM * 0.05)); }

  // Rank compass bearings by how much undefogged STREET lies out that way
  // (fog-only newness as fallback): sample at two ranges along each of 12
  // bearings, then greedily pick well-separated winners. Street scoring stops
  // bearings aiming at rivers, parks and fields that look richly foggy but
  // hold nothing to defog.
  SuggestTool.prototype._loopBearings = function (S, distM) {
    const { kx, ky } = metresPerDeg(S.lat);
    const at = (thDeg, m) => {
      const th = thDeg * Math.PI / 180;
      return L.latLng(S.lat + (Math.cos(th) * m) / ky, S.lng + (Math.sin(th) * m) / kx);
    };
    const R = bearingRadius(distM);
    const score = (p) => {
      const st = this._newAreaM2(p, R);
      return st !== null ? st : this._newness(p) * 2 * R * 30; // fallback on a roughly comparable scale
    };
    const scored = [];
    for (let b = 0; b < 360; b += 30)
      scored.push({ b, score: (score(at(b, distM * 0.25)) + score(at(b, distM * 0.4))) / 2 });
    scored.sort((x, y) => y.score - x.score);
    const picked = [];
    for (const s of scored) {
      if (picked.length >= MAX_LOOPS) break;
      const sep = (a, b2) => { const d = Math.abs(a - b2) % 360; return Math.min(d, 360 - d); };
      if (picked.every((p) => sep(p, s.b) >= 45)) picked.push(s.b);
    }
    return picked;
  };

  // Square-ish loop S → v1 → v2 → v3 → S out along a bearing (S and three vias as the
  // corners, edge a metres, straight perimeter 4a). Three vias give the router much
  // less room than a 2-via triangle to fold the loop into out-and-back spurs.
  SuggestTool.prototype._loopVias = function (S, bearingDeg, a) {
    const { kx, ky } = metresPerDeg(S.lat);
    const at = (thDeg, m) => {
      const th = thDeg * Math.PI / 180;
      return L.latLng(S.lat + (Math.cos(th) * m) / ky, S.lng + (Math.sin(th) * m) / kx);
    };
    return [at(bearingDeg - 45, a), at(bearingDeg, a * Math.SQRT2), at(bearingDeg + 45, a)]
      .map((v) => this._snapToNewStreets(v, a * 0.3));
  };

  // Triangle fallback (2 vias, side D/3.75): used when the square's vias land
  // where the router can't start (water, restricted areas, off the street network). Fewer points, fewer chances to fail.
  SuggestTool.prototype._loopViasTri = function (S, bearingDeg, side) {
    const { kx, ky } = metresPerDeg(S.lat);
    const at = (thDeg) => {
      const th = thDeg * Math.PI / 180;
      return L.latLng(S.lat + (Math.cos(th) * side) / ky, S.lng + (Math.sin(th) * side) / kx);
    };
    return [at(bearingDeg - 30), at(bearingDeg + 30)].map((v) => this._snapToNewStreets(v, side * 0.3));
  };

  // Share of the route's length that runs within ~25 m of another, path-distant part of
  // itself. High values mean out-and-back spurs rather than a proper loop.
  // closed=false (A to B): the start and end are unrelated, so no wrap-around adjacency,
  // and high values mean the route re-walks earlier ground.
  function overlapFrac(coords, closed = true) {
    const { kx, ky } = metresPerDeg(coords.length ? coords[0][1] : 0);
    const d2 = (p, q) => { const dx = (p.x - q.x), dy = (p.y - q.y); return dx * dx + dy * dy; };
    const pts = [];
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      const ax = coords[i - 1][0] * kx, ay = coords[i - 1][1] * ky;
      const bx = coords[i][0] * kx, by = coords[i][1] * ky;
      const len = Math.hypot(bx - ax, by - ay);
      pts.push({ x: (ax + bx) / 2, y: (ay + by) / 2, len, at: acc + len / 2 });
      acc += len;
    }
    let overlap = 0, total = 0;
    for (const p of pts) {
      total += p.len;
      for (const q of pts) {
        const along = Math.abs(p.at - q.at);
        if ((closed ? Math.min(along, acc - along) : along) < 250) continue; // closed: start and end are adjacent, so wrap the path distance
        if (d2(p, q) < 25 * 25) { overlap += p.len; break; }
      }
    }
    return total ? overlap / total : 0;
  }

  function rankKey(gain, retrace) {
    return gain.area * (0.7 + 0.3 * Math.min(1, gain.newPct / 100)) * (1 - RETRACE_WEIGHT * retrace);
  }

  // Cut "there and back" excursions that don't pull their weight: an excursion is a
  // stretch that returns to within 60 m of where it left the route. If the defog area
  // it contributes per metre is under 40% of the route's overall rate, splice it out.
  // That catches dead-end re-walks of covered ground (rate ≈ 0) and marginal wiggles,
  // while keeping spurs INTO fog, which are ugly but often the point of the suggestion.
  // Returns { coords, blockedM }: coords is the spliced geometry (null if nothing was
  // cut) and blockedM the length of cuts wanted but skipped to respect minLenM. Loop
  // callers regrow by that much and retry; p2p callers ignore it.
  function snipOldSpurs(coords, computeGain, minLenM) {
    const none = { coords: null, blockedM: 0 };
    if (!computeGain || coords.length < 10) return none;
    const routeGain = computeGain(coords);
    if (!routeGain || !(routeGain.area > 0)) return none;
    const { kx, ky } = metresPerDeg(coords[0][1]);
    const xy = coords.map((p) => ({ x: p[0] * kx, y: p[1] * ky }));
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y));
    const total = cum[cum.length - 1];
    const routeEff = routeGain.area / total;
    const near = (i, j) => Math.hypot(xy[i].x - xy[j].x, xy[i].y - xy[j].y) < 60;
    const snips = [];
    let i = 0;
    while (i < coords.length - 1) {
      let found = -1;
      for (let j = coords.length - 1; j > i; j--) { // longest excursion from i first
        const ex = cum[j] - cum[i];
        if (ex < 200) break;              // too short to matter (and shrinking further)
        if (ex > total * 0.45) continue;  // never amputate the main loop body
        if (near(i, j)) { found = j; break; }
      }
      if (found < 0) { i++; continue; }
      const without = coords.slice(0, i + 1).concat(coords.slice(found));
      const lost = routeGain.area - ((computeGain(without) || { area: 0 }).area || 0);
      const exLen = cum[found] - cum[i];
      if (lost / exLen < 0.5 * routeEff) snips.push({ i, j: found, cut: exLen });
      i = found;
    }
    // apply biggest cuts first, skip overlapping ones, never fall below minLenM
    snips.sort((a, b) => b.cut - a.cut);
    const applied = [];
    let remaining = total, blockedM = 0;
    for (const s of snips) {
      if (applied.some((a) => s.i < a.j && a.i < s.j)) continue;
      if (remaining - s.cut < minLenM) { blockedM += s.cut; continue; }
      applied.push(s);
      remaining -= s.cut;
    }
    if (!applied.length) return { coords: null, blockedM };
    applied.sort((a, b) => a.i - b.i);
    const out = [];
    let idx = 0;
    for (const s of applied) { out.push(...coords.slice(idx, s.i + 1)); idx = s.j; }
    out.push(...coords.slice(idx));
    return { coords: out, blockedM };
  }

  // Recompute length (and ascent/descent, where the coordinates carry elevation)
  // after geometry surgery.
  function statsFromCoords(coords) {
    const { kx, ky } = metresPerDeg(coords[0][1]);
    const hasZ = coords[0].length > 2;
    let len = 0, asc = 0, desc = 0;
    for (let i = 1; i < coords.length; i++) {
      len += Math.hypot((coords[i][0] - coords[i - 1][0]) * kx, (coords[i][1] - coords[i - 1][1]) * ky);
      if (!hasZ) continue;
      const d = (coords[i][2] || 0) - (coords[i - 1][2] || 0);
      if (d > 0) asc += d; else desc -= d;
    }
    return { coords, lenM: Math.round(len), ascent: hasZ ? Math.round(asc) : undefined, descent: hasZ ? Math.round(desc) : undefined };
  }

  // Editor pins for a routed candidate: its ends plus the street vertices its legs join at.
  // A via pin may sit off the street, and a pin floating off the line would send the first
  // edit's re-route through that point.
  function joinPins(route, from, to) {
    const joins = route.legs.slice(0, -1).map((l) => { const c = l.coords[l.coords.length - 1]; return L.latLng(c[1], c[0]); });
    return [from].concat(joins, [to]);
  }

  // Evenly spaced points along a snipped route's cleaned shape, used as adoption
  // waypoints so a later re-route follows the same streets instead of re-growing the spur.
  function resampleMids(coords, n) {
    const { kx, ky } = metresPerDeg(coords[0][1]);
    const cum = [0];
    for (let i = 1; i < coords.length; i++)
      cum.push(cum[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * kx, (coords[i][1] - coords[i - 1][1]) * ky));
    const total = cum[cum.length - 1];
    const mids = [];
    let k = 1;
    for (let t = 1; t <= n; t++) {
      const target = total * t / (n + 1);
      while (k < cum.length - 1 && cum[k] < target) k++;
      mids.push(L.latLng(coords[k][1], coords[k][0]));
    }
    return mids;
  }

  SuggestTool.prototype._suggestLoop = async function (profile, distM, buffer) {
    if (!this.a || !distM) return;
    this.clearResults();
    const runId = this._runId;
    const stale = () => runId !== this._runId;
    const emit = (s) => { if (!stale() && this.onResults) this.onResults(s); };
    const S = this.a.getLatLng();
    const bufferPct = Math.round(buffer * 100);
    if (distM > MAX_LOOP_M) { emit({ empty: true, reason: "too-long", targetKm: distM / 1000, bufferPct, maxKm: MAX_LOOP_M / 1000 }); return; }
    const inTol = (lenM) => Math.abs(lenM - distM) <= buffer * distM;

    // Streets first: routing runs on them, and bearings and vias chase undefogged
    // streets rather than raw fog. One rect around the whole reach, capped so a
    // very long loop downloads a bounded area (its far side may then be out of
    // reach).
    if (!this.streets) { emit({ error: true, reason: "no-street-data" }); return; }
    const { kx, ky } = metresPerDeg(S.lat);
    // build the fetch area around a grid-snapped centre so a rerun (same
    // or slightly nudged pin) reuses the cache; the planner still uses the
    // true S, and the area's 800 m margin absorbs the snap offset
    const c = this.streets.snapPoint(S);
    const half = Math.min(distM * 0.45 + 800, 9000);
    const rects = [{ s: c.lat - half / ky, n: c.lat + half / ky, w: c.lng - half / kx, e: c.lng + half / kx }];
    if (!(await this._loadStreets(rects, profile, emit, stale))) return;
    const planner = this._getPlanner(profile);
    if (!planner) { emit({ error: true, reason: "no-street-data" }); return; }

    // Search the street network itself for high-defog loops (thin shapes, odd
    // topologies: whatever the fog asks for). Only for distances the capped rect
    // reaches whole, and only where new ground is scarce enough that shape
    // matters: in mostly-virgin areas wide simple loops already defog near the
    // ceiling and planned walks measured worse.
    let planned = [];
    if (distM <= 16000) {
      try {
        if (planner.meanFracNear(S, Math.min(1800, distM * 0.18)) < 0.82)
          planned = planner.planLoop(S, distM, buffer, 4);
      } catch (e) {}
    }
    // With planner candidates in hand, compass-square candidates become a
    // safety net, but a real one: in dense fringe the best square still beats
    // the best plan at times, so keep three even when plans are plentiful.
    const bearings = this._loopBearings(S, distM)
      .slice(0, planned.length >= 3 ? 3 : planned.length >= 1 ? 4 : MAX_LOOPS);
    const total = bearings.length + planned.length;
    emit({ loading: true, phase: "loops", done: 0, total });

    // 5: roads inflate the straight square (4a) by ~25%, so start with perimeter = D/1.25.
    // If the routed loop misses the tolerance, retry once with a proportionally scaled shape;
    // if the square doesn't route at all, fall back to a triangle on the same bearing.
    const loopWps = (vias) => [S].concat(vias, [S]);
    const fails = { server: 0, tol: 0 };
    const floor = distM * (1 - buffer);
    const plannedJobs = planned.map((pl) => async () => {
      const raw = statsFromCoords(pl.coords);
      const snip = snipOldSpurs(raw.coords, this.computeGain, floor);
      const c = snip.coords
        ? { r: statsFromCoords(snip.coords), adoptWps: [S].concat(resampleMids(snip.coords, 6), [S]) }
        : { r: raw, adoptWps: pl.wps };
      if (!inTol(c.r.lenM)) { fails.tol++; return null; }
      return { r: c.r, adoptWps: c.adoptWps, overlap: overlapFrac(c.r.coords), planned: true };
    });
    const jobs = plannedJobs.concat(bearings.map((bearing) => async () => {
      let mk = (d) => this._loopVias(S, bearing, d);
      // route + snip in one step, so tolerance and the rescale-retry both judge the
      // CLEANED length, so a loop whose snips pull it under target gets regrown, not binned
      const prep = async (d) => {
        const vias = mk(d);
        const raw = await this._route(loopWps(vias), profile);
        if (!raw || !raw.lenM) return null;
        const snip = snipOldSpurs(raw.coords, this.computeGain, floor);
        return snip.coords
          ? { r: statsFromCoords(snip.coords), adoptWps: [S].concat(resampleMids(snip.coords, 4), [S]), blockedM: snip.blockedM }
          : { r: raw, adoptWps: joinPins(raw, S, S), blockedM: snip.blockedM };
      };
      let dim = distM / 5;
      let c = await prep(dim);
      if (!c) {
        mk = (d) => this._loopViasTri(S, bearing, d);
        dim = distM / 3.75;
        c = await prep(dim);
      }
      if (!c) { fails.server++; return null; }
      // retry when out of tolerance OR a wanted snip was blocked by the tolerance floor;
      // regrowing by the blocked amount makes the cut affordable on the second pass
      const badness = (x) => (inTol(x.r.lenM) ? 0 : 2) + (x.blockedM > 0 ? 1 : 0);
      // up to two improvement passes: a far-off first shot may need one rescale to reach
      // tolerance and a second to regrow room for a floor-blocked snip
      for (let attempt = 0; attempt < 2 && badness(c) > 0; attempt++) {
        dim *= Math.min(2.5, Math.max(0.4, (distM + c.blockedM) / c.r.lenM));
        const c2 = await prep(dim);
        if (!c2) break;
        const better = badness(c2) < badness(c) ||
          (badness(c2) === badness(c) && Math.abs(c2.r.lenM - distM) < Math.abs(c.r.lenM - distM));
        if (!better) break;
        c = c2;
      }
      if (!inTol(c.r.lenM)) { fails.tol++; return null; }
      return { r: c.r, adoptWps: c.adoptWps, overlap: overlapFrac(c.r.coords) };
    }));

    const found = await this._pool(jobs, stale, (done) => emit({ loading: true, phase: "loops", done, total }));
    if (stale()) return;
    if (!found.length && fails.server > 0 && fails.tol === 0) {
      // nothing routed at all, a server problem, not a tolerance problem; say so
      emit({ empty: true, reason: "server", targetKm: distM / 1000, bufferPct });
      return;
    }
    // Drop square candidates that retrace >30% of themselves: for THEM overlap
    // is a generation defect (a square folding into out-and-back
    // spurs). Planned routes are exempt: when the planner retraces, it decided
    // the retrace pays (e.g. a bridge is the only way over and back, and a
    // "lollipop" out to rich streets beats a forced giant detour).
    const clean = found.filter((c) => c.planned || c.overlap <= 0.3);
    this._finish(runId, clean.length ? clean : found, { targetKm: distM / 1000, bufferPct });
  };

  SuggestTool._internals = { snipOldSpurs, overlapFrac, rankKey, RETRACE_WEIGHT, statsFromCoords, joinPins, p2pWindow, p2pCandidates }; // for tests
  global.SuggestTool = SuggestTool;
})(window);
