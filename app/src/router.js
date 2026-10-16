// Point-to-point routing over the street graph GraphPlanner builds from the
// Overpass ways, so suggestions never need a routing server. Cost is plain
// length: the cached ways carry no surface tags, so profiles differ only in which
// ways the graph holds and which direction of a one-way they may take.
(function (global) {
  const SNAP_M = 600;     // a point farther than this from every street is off the network
  const GRID_M = 100;     // spatial grid of edges, for snapping
  const GAP_CELL_M = 250; // grid size for the closest approach between two pieces of the map
  const AVOID_COST = 8;   // avoided edges cost 8x, not infinity: a dead-end start whose only exit is avoided must still leave
  const AT_NODE_M = 0.05; // a snap this close to an end of its edge is that junction

  function LocalRouter(planner) { this.planner = planner; }

  const cellKey = (cx, cy) => (cx + 1e6) * 2e6 + (cy + 1e6);

  // Per-graph tables, rebuilt with the graph: a grid of which edges pass through each
  // cell, each edge's cumulative length at its vertices, and search scratch arrays
  // (stamped, so a search never clears or reallocates them).
  LocalRouter.prototype._cache = function () {
    const pl = this.planner;
    if (pl._routerCache && pl._routerCache.edges === pl.edges) return pl._routerCache;
    const grid = new Map(), cum = new Array(pl.edges.length);
    pl.edges.forEach((e, i) => {
      const c = e.coords, m = [0];
      let last = -1;
      const add = (x, y) => {
        const k = cellKey(Math.floor(x * pl.kx / GRID_M), Math.floor(y * pl.ky / GRID_M));
        if (k === last) return;
        last = k;
        (grid.get(k) || grid.set(k, []).get(k)).push(i);
      };
      add(c[0][0], c[0][1]);
      for (let j = 1; j < c.length; j++) {
        const d = Math.hypot((c[j][0] - c[j - 1][0]) * pl.kx, (c[j][1] - c[j - 1][1]) * pl.ky);
        m.push(m[j - 1] + d);
        const n = Math.ceil(d / (GRID_M / 2)); // a sample every half cell, so a street is found from any cell it crosses by more than half a cell
        for (let s = 1; s <= n; s++) add(c[j - 1][0] + (c[j][0] - c[j - 1][0]) * s / n, c[j - 1][1] + (c[j][1] - c[j - 1][1]) * s / n);
      }
      cum[i] = m;
    });
    const N = pl.lons.length;
    return (pl._routerCache = { edges: pl.edges, grid, cum, dist: new Float64Array(N), prev: new Int32Array(N), stamp: new Uint32Array(N), run: 0 });
  };

  // Closest point of edge ei to (px, py) in metres: { e, d, seg, c (length along the edge), lon, lat }.
  LocalRouter.prototype._project = function (ei, px, py) {
    const pl = this.planner, cs = pl.edges[ei].coords, cum = this._cache().cum[ei];
    let best = null;
    for (let j = 1; j < cs.length; j++) {
      const ax = cs[j - 1][0] * pl.kx, ay = cs[j - 1][1] * pl.ky, bx = cs[j][0] * pl.kx, by = cs[j][1] * pl.ky;
      const sx = bx - ax, sy = by - ay, len2 = sx * sx + sy * sy;
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy) / len2)) : 0;
      const d = Math.hypot(ax + sx * t - px, ay + sy * t - py);
      if (!best || d < best.d) {
        best = { e: ei, d, seg: j - 1, c: cum[j - 1] + t * (cum[j] - cum[j - 1]),
          lon: cs[j - 1][0] + (cs[j][0] - cs[j - 1][0]) * t, lat: cs[j - 1][1] + (cs[j][1] - cs[j - 1][1]) * t };
      }
    }
    return best;
  };

  // Where a point lands on the street map: the closest point on a street within SNAP_M,
  // or null. A street in a stray fragment (courtyard, station) only counts when no
  // street of a real network is in reach, so a pin beside a fragment still starts on the map.
  LocalRouter.prototype._snap = function (p) {
    const pl = this.planner, grid = this._cache().grid;
    const px = p.lng * pl.kx, py = p.lat * pl.ky, cx = Math.floor(px / GRID_M), cy = Math.floor(py / GRID_M);
    const seen = new Set();
    let net = null, any = null;
    for (let r = 0; r <= Math.ceil(SNAP_M / GRID_M) + 1; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        for (const ei of grid.get(cellKey(cx + dx, cy + dy)) || []) {
          if (seen.has(ei)) continue;
          seen.add(ei);
          const s = this._project(ei, px, py);
          if (s.d > SNAP_M) continue;
          if (!any || s.d < any.d) any = s;
          if (pl.inNet[pl.edges[ei].a] && (!net || s.d < net.d)) net = s;
        }
      }
      if (net && net.d <= r * GRID_M) break; // nothing in a farther ring is nearer
    }
    return net || any;
  };

  // Distance to the closest street vertex anywhere (failure reports only).
  LocalRouter.prototype._nearestM = function (p) {
    const pl = this.planner;
    let best = Infinity;
    for (const e of pl.edges) for (const c of e.coords)
      best = Math.min(best, Math.hypot((c[0] - p.lng) * pl.kx, (c[1] - p.lat) * pl.ky));
    return Math.round(best);
  };

  // Why a route does or doesn't exist, for the user and the logs: per point the snap
  // it got, how big a piece of the street map it sits on, and for a failure the reason
  // ("off-network" with the point's index, or "no-path" with a close pair of nodes
  // between the two pieces, see _gap). Mirrors route() but reports instead of returning null.
  LocalRouter.prototype.explain = function (points, opts) {
    const pl = this.planner;
    pl.build();
    if (!pl.lons.length) return { reason: "no-street-data", points: [], graph: { nodes: 0, edges: 0, pieces: 0 } };
    const snaps = points.map((p) => this._snap(p));
    const pts = points.map((p, i) => {
      const s = snaps[i];
      if (!s) return { snapM: null, nearestM: this._nearestM(p) };
      const node = pl.edges[s.e].a;
      return { edge: s.e, snapM: Math.round(s.d), nearestM: Math.round(s.d), piece: pl.pieceOf[node], pieceNodes: pl.pieces[pl.pieceOf[node]].length, inNet: !!pl.inNet[node] };
    });
    const ways = pl.streets.ways;
    const graph = { nodes: pl.lons.length, edges: pl.edges.length, pieces: pl.pieces.length, ways: ways.length, usableWays: ways.filter((w) => pl.usable(w.id)).length };
    const off = snaps.indexOf(null);
    if (off >= 0) return { reason: "off-network", point: off, points: pts, graph };
    for (let i = 1; i < snaps.length; i++) {
      if (this._path(snaps[i - 1], snaps[i], opts && opts.avoid)) continue;
      // same piece of the map but still no way: only a one-way can be in the road
      if (pts[i - 1].piece === pts[i].piece) return { reason: "one-way", leg: i - 1, points: pts, graph };
      return { reason: "no-path", leg: i - 1, points: pts, graph, gap: this._gap(pts[i - 1].piece, pts[i].piece) };
    }
    return { reason: null, points: pts, graph };
  };

  // A close pair of nodes between two pieces, as { m, a, b } ([lon,lat] each): the
  // closest pair when within GAP_CELL_M, only an upper bound up to about three cells,
  // and null beyond that.
  LocalRouter.prototype._gap = function (pa, pb) {
    const pl = this.planner;
    const [small, big] = [pl.pieces[pa], pl.pieces[pb]].sort((x, y) => x.length - y.length);
    const cell = (n) => Math.floor(pl.lons[n] * pl.kx / GAP_CELL_M) + "," + Math.floor(pl.lats[n] * pl.ky / GAP_CELL_M);
    const grid = new Map();
    for (const n of big) { const k = cell(n); (grid.get(k) || grid.set(k, []).get(k)).push(n); }
    let best = null;
    for (const a of small) {
      const cx = Math.floor(pl.lons[a] * pl.kx / GAP_CELL_M), cy = Math.floor(pl.lats[a] * pl.ky / GAP_CELL_M);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
        for (const b of grid.get((cx + dx) + "," + (cy + dy)) || []) {
          const m = Math.hypot((pl.lons[a] - pl.lons[b]) * pl.kx, (pl.lats[a] - pl.lats[b]) * pl.ky);
          if (!best || m < best.m) best = { m, a: [pl.lons[a], pl.lats[a]], b: [pl.lons[b], pl.lats[b]] };
        }
    }
    return best && Object.assign(best, { m: Math.round(best.m) });
  };

  // The street from a snapped point back to its edge's first node (toward "a") or on to its
  // last node ("b"): [point, vertices..., node].
  LocalRouter.prototype._part = function (s, toward) {
    const cs = this.planner.edges[s.e].coords, pt = [s.lon, s.lat];
    if (toward === "a") { const out = [pt]; for (let j = s.seg; j >= 0; j--) out.push(cs[j]); return out; }
    const out = [pt];
    for (let j = s.seg + 1; j < cs.length; j++) out.push(cs[j]);
    return out;
  };

  // Where a path can leave a snapped point (to a node, at what cost, along which part of the
  // edge), and where it can arrive. A one-way edge only opens in its direction, except
  // that a point sitting on a junction is the junction.
  // A part of an avoided edge costs like the rest of it. Exits and entries carry the
  // length actually walked as `len` and the cost the search weighs as `cost`.
  LocalRouter.prototype._exits = function (s, avoid) {
    const e = this.planner.edges[s.e], out = [], w = avoid && avoid.has(s.e) ? AVOID_COST : 1;
    if (s.c <= AT_NODE_M || !e.dir || e.dir < 0) out.push({ node: e.a, len: s.c, cost: s.c * w, part: this._part(s, "a") });
    if (e.len - s.c <= AT_NODE_M || !e.dir || e.dir > 0) out.push({ node: e.b, len: e.len - s.c, cost: (e.len - s.c) * w, part: this._part(s, "b") });
    return out;
  };
  LocalRouter.prototype._entries = function (s, avoid) {
    const e = this.planner.edges[s.e], out = [], w = avoid && avoid.has(s.e) ? AVOID_COST : 1;
    if (s.c <= AT_NODE_M || !e.dir || e.dir > 0) out.push({ node: e.a, len: s.c, cost: s.c * w, part: this._part(s, "a").reverse() });
    if (e.len - s.c <= AT_NODE_M || !e.dir || e.dir < 0) out.push({ node: e.b, len: e.len - s.c, cost: (e.len - s.c) * w, part: this._part(s, "b").reverse() });
    return out;
  };

  // Two points on one edge: straight along it, if its direction allows.
  LocalRouter.prototype._along = function (a, b, avoid) {
    const e = this.planner.edges[a.e], cs = e.coords, forward = b.c >= a.c;
    if (forward ? e.dir < 0 : e.dir > 0) return null;
    const coords = [[a.lon, a.lat]];
    if (forward) for (let j = a.seg + 1; j <= b.seg; j++) coords.push(cs[j]);
    else for (let j = a.seg; j > b.seg; j--) coords.push(cs[j]);
    coords.push([b.lon, b.lat]);
    return { cost: Math.abs(b.c - a.c) * (avoid && avoid.has(a.e) ? AVOID_COST : 1), coords, edges: [a.e] };
  };

  // Cheapest way from the starts to the ends (each {node, cost, part}): A* with the straight
  // line as the guide, which never overestimates since an edge is at least as long as the
  // line between its nodes.
  LocalRouter.prototype._search = function (starts, ends, avoid) {
    const pl = this.planner, c = this._cache(), run = ++c.run, { dist, prev, stamp } = c;
    const get = (v) => (stamp[v] === run ? dist[v] : Infinity);
    const guide = (u) => {
      let m = Infinity;
      for (const t of ends) m = Math.min(m, Math.hypot((pl.lons[u] - pl.lons[t.node]) * pl.kx, (pl.lats[u] - pl.lats[t.node]) * pl.ky));
      return m;
    };
    const heap = new GraphPlanner.Heap();
    for (const s of starts) if (s.cost < get(s.node)) { stamp[s.node] = run; dist[s.node] = s.cost; prev[s.node] = -1; heap.push(s.node, s.cost + guide(s.node)); }
    let best = Infinity, bestNode = -1;
    while (!heap.empty()) {
      const { node: u, dist: f } = heap.pop();
      if (f >= best) break;
      const du = dist[u];
      if (f > du + guide(u) + 1e-9) continue; // an outdated queue entry
      for (const t of ends) if (t.node === u && du + t.cost < best) { best = du + t.cost; bestNode = u; }
      for (const ei of pl.adj[u]) {
        const e = pl.edges[ei];
        if (!pl.canLeave(e, u)) continue;
        const v = e.a === u ? e.b : e.a;
        const nd = du + e.len * (avoid && avoid.has(ei) ? AVOID_COST : 1);
        if (nd < get(v)) { stamp[v] = run; dist[v] = nd; prev[v] = ei; heap.push(v, nd + guide(v)); }
      }
    }
    if (bestNode < 0) return null;
    const edges = [];
    let n = bestNode;
    while (prev[n] >= 0) { edges.push(prev[n]); n = pl.edges[prev[n]].a === n ? pl.edges[prev[n]].b : pl.edges[prev[n]].a; }
    edges.reverse();
    const start = starts.filter((s) => s.node === n).sort((x, y) => x.cost - y.cost)[0];
    const end = ends.filter((t) => t.node === bestNode).sort((x, y) => x.cost - y.cost)[0];
    return { cost: best, origin: n, edges, start, end };
  };

  // The street path between two snapped points: { coords, edges }, or null when there is none.
  // edges are the graph edges walked, including a partly walked edge at either end.
  LocalRouter.prototype._path = function (a, b, avoid) {
    const pl = this.planner;
    const hit = this._search(this._exits(a, avoid), this._entries(b, avoid), avoid);
    const same = a.e === b.e ? this._along(a, b, avoid) : null;
    if (same && (!hit || same.cost <= hit.cost)) return same;
    if (!hit) return null;
    const coords = [];
    const push = (pt) => { const l = coords[coords.length - 1]; if (!l || l[0] !== pt[0] || l[1] !== pt[1]) coords.push(pt); };
    hit.start.part.forEach(push);
    let at = hit.origin;
    for (const ei of hit.edges) {
      const e = pl.edges[ei];
      (e.a === at ? e.coords : e.coords.slice().reverse()).forEach(push);
      at = e.a === at ? e.b : e.a;
    }
    hit.end.part.forEach(push);
    const edges = hit.edges.slice();
    if (hit.start.len > AT_NODE_M && edges[0] !== a.e) edges.unshift(a.e);
    if (hit.end.len > AT_NODE_M && edges[edges.length - 1] !== b.e) edges.push(b.e);
    return { coords, edges };
  };

  // points: [{lat,lng}], each snapped onto the nearest street within SNAP_M; first and
  // last are kept exactly, joined to the street by a straight stub. Returns
  // { coords, lenM, legs: [{coords, edges}] } or null.
  LocalRouter.prototype.route = function (points, opts) {
    const pl = this.planner;
    if (points.length < 2) return null;
    pl.build();
    const snaps = points.map((p) => this._snap(p));
    if (snaps.includes(null)) return null;
    const legs = [];
    for (let i = 1; i < snaps.length; i++) {
      const leg = this._path(snaps[i - 1], snaps[i], opts && opts.avoid);
      if (!leg) return null;
      legs.push(leg);
    }
    const stub = (leg, pin, at) => { // join a pin to the street, unless it is on it
      const near = leg.coords[at === 0 ? 0 : leg.coords.length - 1];
      if (Math.hypot((near[0] - pin.lng) * pl.kx, (near[1] - pin.lat) * pl.ky) < AT_NODE_M) leg.coords[at === 0 ? 0 : leg.coords.length - 1] = [pin.lng, pin.lat];
      else if (at === 0) leg.coords.unshift([pin.lng, pin.lat]);
      else leg.coords.push([pin.lng, pin.lat]);
    };
    stub(legs[0], points[0], 0);
    stub(legs[legs.length - 1], points[points.length - 1], 1);
    const coords = legs[0].coords.slice();
    for (let i = 1; i < legs.length; i++) for (let k = 1; k < legs[i].coords.length; k++) coords.push(legs[i].coords[k]);
    let lenM = 0;
    for (let i = 1; i < coords.length; i++)
      lenM += Math.hypot((coords[i][0] - coords[i - 1][0]) * pl.kx, (coords[i][1] - coords[i - 1][1]) * pl.ky);
    return { coords, lenM, legs };
  };

  global.LocalRouter = LocalRouter;
})(window);
