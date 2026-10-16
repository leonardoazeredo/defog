// Point-to-point routing over the street graph GraphPlanner builds from the
// Overpass ways, so suggestions never need a routing server. Cost is plain
// length: the cached ways carry no tags, so there are no one-ways or surface
// preferences to weigh; profiles differ only in which ways the graph holds.
(function (global) {
  const SNAP_M = 600;     // a point farther than this from every node is off the network
  const GAP_CELL_M = 250; // grid size for the closest approach between two pieces of the map
  const AVOID_COST = 8;   // avoided edges cost 8x, not infinity: a dead-end start whose only exit is avoided must still leave

  function LocalRouter(planner) { this.planner = planner; }

  // Nearest node of any degree: unlike planner.nearestNode a dead end is fine,
  // the route just starts with a spur. A node in a stray fragment only counts when
  // no real network node is in reach (the fragment is then all there is).
  LocalRouter.prototype._snap = function (p) {
    const pl = this.planner;
    let best = -1, bd = SNAP_M * SNAP_M, any = -1, ad = SNAP_M * SNAP_M;
    for (let i = 0; i < pl.lons.length; i++) {
      const dx = (pl.lons[i] - p.lng) * pl.kx, dy = (pl.lats[i] - p.lat) * pl.ky;
      const d = dx * dx + dy * dy;
      if (d < ad) { ad = d; any = i; }
      if (d < bd && pl.inNet[i]) { bd = d; best = i; }
    }
    return best >= 0 ? best : any;
  };

  // Why a route does or doesn't exist, for the user and the logs: per point the snap
  // it got, how big a piece of the street map it sits on, and for a failure the reason
  // ("off-network" with the point's index, or "no-path" with a close pair of nodes
  // between the two pieces, see _gap). Mirrors route() but reports instead of returning null.
  LocalRouter.prototype.explain = function (points, opts) {
    const pl = this.planner;
    pl.build();
    const nodes = points.map((p) => this._snap(p));
    const metres = (n, p) => Math.hypot((pl.lons[n] - p.lng) * pl.kx, (pl.lats[n] - p.lat) * pl.ky);
    const pts = points.map((p, i) => {
      let near = Infinity;
      for (let n = 0; n < pl.lons.length; n++) near = Math.min(near, metres(n, p));
      const n = nodes[i];
      if (n < 0) return { node: -1, snapM: null, nearestM: Math.round(near) };
      return { node: n, snapM: Math.round(metres(n, p)), nearestM: Math.round(near), piece: pl.pieceOf[n], pieceNodes: pl.pieces[pl.pieceOf[n]].length, inNet: !!pl.inNet[n] };
    });
    const ways = pl.streets.ways;
    const graph = { nodes: pl.lons.length, edges: pl.edges.length, pieces: pl.pieces.length, ways: ways.length, usableWays: ways.filter((w) => pl.usable(w.id)).length };
    const off = nodes.indexOf(-1);
    if (off >= 0) return { reason: "off-network", point: off, points: pts, graph };
    for (let i = 1; i < nodes.length; i++) {
      if (this._path(nodes[i - 1], nodes[i], opts && opts.avoid)) continue;
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

  // Edge ids from src to dst, or null when they are not connected.
  LocalRouter.prototype._path = function (src, dst, avoid) {
    const pl = this.planner;
    const dist = new Float64Array(pl.lons.length).fill(Infinity);
    const prev = new Int32Array(pl.lons.length).fill(-1);
    dist[src] = 0;
    const h = new GraphPlanner.Heap();
    h.push(src, 0);
    while (!h.empty()) {
      const { node: u, dist: du } = h.pop();
      if (u === dst) break;
      if (du > dist[u]) continue;
      for (const ei of pl.adj[u]) {
        const e = pl.edges[ei];
        const v = e.a === u ? e.b : e.a;
        const nd = du + e.len * (avoid && avoid.has(ei) ? AVOID_COST : 1);
        if (nd < dist[v]) { dist[v] = nd; prev[v] = ei; h.push(v, nd); }
      }
    }
    if (!isFinite(dist[dst])) return null;
    const edges = [];
    for (let n = dst; n !== src;) {
      const ei = prev[n];
      edges.push(ei);
      n = pl.edges[ei].a === n ? pl.edges[ei].b : pl.edges[ei].a;
    }
    return edges.reverse();
  };

  // points: [{lat,lng}], each snapped to the nearest node within SNAP_M; first and
  // last are kept exactly, joined to the street by a straight stub. Returns { coords, lenM, legs: [{coords, edges}] } or null.
  LocalRouter.prototype.route = function (points, opts) {
    const pl = this.planner;
    if (points.length < 2) return null;
    pl.build();
    const avoid = opts && opts.avoid;
    const nodes = points.map((p) => this._snap(p));
    if (nodes.includes(-1)) return null;
    const legs = [];
    for (let i = 1; i < nodes.length; i++) {
      const edges = this._path(nodes[i - 1], nodes[i], avoid);
      if (!edges) return null;
      const coords = [[pl.lons[nodes[i - 1]], pl.lats[nodes[i - 1]]]];
      let at = nodes[i - 1];
      for (const ei of edges) {
        const e = pl.edges[ei];
        const cs = e.a === at ? e.coords : e.coords.slice().reverse();
        for (let k = 1; k < cs.length; k++) coords.push(cs[k]);
        at = e.a === at ? e.b : e.a;
      }
      legs.push({ coords, edges });
    }
    const first = points[0], last = points[points.length - 1];
    legs[0].coords.unshift([first.lng, first.lat]);
    legs[legs.length - 1].coords.push([last.lng, last.lat]);
    const coords = legs[0].coords.slice();
    for (let i = 1; i < legs.length; i++) for (let k = 1; k < legs[i].coords.length; k++) coords.push(legs[i].coords[k]);
    let lenM = 0;
    for (let i = 1; i < coords.length; i++)
      lenM += Math.hypot((coords[i][0] - coords[i - 1][0]) * pl.kx, (coords[i][1] - coords[i - 1][1]) * pl.ky);
    return { coords, lenM, legs };
  };

  global.LocalRouter = LocalRouter;
})(window);
