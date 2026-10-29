// Graph route planner: searches the real street network for the loop or A-to-B
// walk that defogs the most, instead of hoping a handful of via pins steers a
// router there. Works on the ways already fetched by StreetIndex: shared OSM
// node ids give connectivity, and every edge carries a reward = the still-
// fogged area its ~30 m corridor would clear. The search is a greedy
// insertion over "pockets" (clusters of rewarding streets) connected by
// reward-hungry shortest paths, with each traversed edge's reward spent so the
// way back is pushed onto different streets: that is what makes long thin
// loops (out one fogged street, back a parallel one) fall out naturally.
// Everything runs locally and every plan carries its own street geometry.
(function (global) {
  const SAMPLE_M = 25;        // reward sampling step along an edge
  const CORRIDOR_M = 30;      // full width Fog of World clears as you travel
  const POCKET_GRID_M = 300;  // pocket = rewarding streets clustered at this scale
  const POCKET_MIN_M2 = 1200; // ignore pockets worth less than ~40 m of virgin street
  const MAX_POCKETS = 120;    // keep NEAR pockets too: a tight cap left growth
                              // starved (9 of 60 in reach at one field start)
  const MAX_ANCHORS = 9;      // start + up to 8 pockets per loop
  const RICH_PULL = 0.65;     // how strongly connecting paths bend toward reward
  const REUSE_COST = 1.8;     // cost multiplier for re-walking an edge the plan already used
  const RETRACE_WEIGHT = 0.5; // ranking discount for re-walked ground: predicted gain doesn't price the re-walk
  const PARALLEL_M = 22;      // spending an edge also spends parallels this close
  const NET_MIN_NODES = 50;   // a connected piece of street map smaller than this is a fragment (courtyard, station), not a network to start from

  // ---- binary heap keyed by dist -------------------------------------------
  function Heap() { this.n = []; this.d = []; }
  Heap.prototype.push = function (node, dist) {
    const n = this.n, d = this.d;
    let i = n.length; n.push(node); d.push(dist);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p] <= d[i]) break;
      [n[p], n[i]] = [n[i], n[p]]; [d[p], d[i]] = [d[i], d[p]]; i = p;
    }
  };
  Heap.prototype.pop = function () {
    const n = this.n, d = this.d;
    const top = { node: n[0], dist: d[0] };
    const ln = n.pop(), ld = d.pop();
    if (n.length) {
      n[0] = ln; d[0] = ld;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < n.length && d[l] < d[m]) m = l;
        if (r < n.length && d[r] < d[m]) m = r;
        if (m === i) break;
        [n[m], n[i]] = [n[i], n[m]]; [d[m], d[i]] = [d[i], d[m]]; i = m;
      }
    }
    return top;
  };
  Heap.prototype.empty = function () { return this.n.length === 0; };

  // newFrac is ~25 cell lookups a call; edges sample every 25 m, so cache by a
  // ~10 m grid (the fog does not change during one plan; a fog change resets this cache at the next build()).
  function fracCache(newFrac) {
    const cache = new Map();
    return (lon, lat) => {
      const key = Math.round(lon * 1e4) * 2e6 + Math.round(lat * 1e4);
      let v = cache.get(key);
      if (v === undefined) { v = newFrac(lon, lat); cache.set(key, v); }
      return v;
    };
  }

  // usable: wayId -> may this travel class use the way; dirOf: wayId -> 1 when the way
  // may only be travelled along its node order, -1 against it, 0 both ways
  // fogVersion: () -> a number that changes whenever the fog does; the graph's rewards are rebuilt when it moves
  function GraphPlanner(streets, newFrac, usable, dirOf, fogVersion) {
    this.streets = streets;
    this.usable = usable || (() => true);
    this.dirOf = dirOf || (() => 0);
    this.fogVersion = fogVersion || (() => 0);
    this.rawFrac = newFrac;
    this.newFrac = fracCache(newFrac);
    this.fracFog = this.fogVersion(); // the fog the fraction cache is filled under
    this.builtStamp = ""; // what the graph was built from; rebuild when a fetch or the fog changed it
    this.held = false; // true while a suggestion plans on it: build() then keeps the graph, so its edge ids stay valid
  }

  // A held graph keeps its edge ids through build(); the holder releases it when its run ends.
  GraphPlanner.prototype.hold = function () { this.held = true; };
  GraphPlanner.prototype.release = function () { this.held = false; };

  // what build() would build from now: the ways, the lists a fetch changed and the fog
  GraphPlanner.prototype.stamp = function () {
    return this.streets.ways.length + "." + (this.streets.version || 0) + "." + this.fogVersion();
  };
  GraphPlanner.prototype.isCurrent = function () { return !!this.adj && this.builtStamp === this.stamp(); };

  // ---- graph construction --------------------------------------------------
  // Nodes: way endpoints + any OSM node shared by 2+ ways (intersections).
  // Edges: the way pieces between nodes, each with geometry, length and reward.
  GraphPlanner.prototype.build = function () {
    if (this.held && this.adj) return;
    const ways = this.streets.ways;
    // new ways, or lists (classes, one-ways) that a fetch changed on ways we already hold
    const fog = this.fogVersion();
    const stamp = this.stamp();
    if (this.builtStamp === stamp && this.adj) return;
    // the cache memoises fractions per ~10 m, so after a fog change it would hand the rebuild the old ones
    if (fog !== this.fracFog) { this.newFrac = fracCache(this.rawFrac); this.fracFog = fog; }
    const t0 = Date.now();
    const uses = new Map();
    for (const w of ways) {
      if (!this.usable(w.id)) continue;
      for (let i = 0; i < w.nodes.length; i++) {
        const id = w.nodes[i];
        // interior nodes count once per way; endpoints get +1 so a dead end still splits
        uses.set(id, (uses.get(id) || 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1));
      }
    }
    const nid2idx = new Map();
    const lons = [], lats = [];
    const nodeIdx = (id, lon, lat) => {
      let ix = nid2idx.get(id);
      if (ix === undefined) { ix = lons.length; nid2idx.set(id, ix); lons.push(lon); lats.push(lat); }
      return ix;
    };
    const kx = 111320 * Math.cos((ways.length ? ways[0].geometry[0].lat : 0) * Math.PI / 180);
    const ky = 110540;
    this.kx = kx; this.ky = ky;

    this.edges = [];      // {a,b,len,coords:[[lon,lat]..],way: OSM way id,dir: 1 a->b only, -1 b->a only, 0 both}
    this.reward = [];     // base reward per edge, m² (static)
    this.spentVer = [];   // reward-claim stamp per edge (see _fresh)
    this.usedVer = [];    // traversal stamp: walked edges cost extra to re-walk
    const midGrid = new Map(); // 100 m bins of edge sample points, for parallel spend
    this.midGrid = midGrid;
    const pushEdge = (aId, bId, coords, wayId, dir) => {
      let len = 0, rew = 0;
      const samples = [];
      for (let i = 1; i < coords.length; i++) {
        const [alon, alat] = coords[i - 1], [blon, blat] = coords[i];
        const em = Math.hypot((blon - alon) * kx, (blat - alat) * ky);
        const n = Math.max(1, Math.round(em / SAMPLE_M));
        for (let s = 0; s < n; s++) {
          const t = (s + 0.5) / n;
          const lon = alon + (blon - alon) * t, lat = alat + (blat - alat) * t;
          rew += (em / n) * CORRIDOR_M * this.newFrac(lon, lat);
          samples.push([lon * kx, lat * ky]);
        }
        len += em;
      }
      if (len < 5) return;
      const e = this.edges.length;
      this.edges.push({
        a: nodeIdx(aId, coords[0][0], coords[0][1]),
        b: nodeIdx(bId, coords[coords.length - 1][0], coords[coords.length - 1][1]),
        len, coords, way: wayId, dir
      });
      this.reward.push(rew);
      this.spentVer.push(0);
      this.usedVer.push(0);
      for (const [x, y] of samples) {
        const key = Math.floor(x / 100) + "," + Math.floor(y / 100);
        let cell = midGrid.get(key);
        if (!cell) midGrid.set(key, (cell = []));
        cell.push({ x, y, e });
      }
    };
    for (const w of ways) {
      if (!this.usable(w.id)) continue;
      let start = 0;
      for (let i = 1; i < w.nodes.length; i++) {
        if (i === w.nodes.length - 1 || uses.get(w.nodes[i]) >= 2) {
          pushEdge(w.nodes[start], w.nodes[i],
            w.geometry.slice(start, i + 1).map((g) => [g.lon, g.lat]), w.id, this.dirOf(w.id));
          start = i;
        }
      }
    }
    this.lons = lons; this.lats = lats;
    this.adj = Array.from({ length: lons.length }, () => []);
    this.edges.forEach((e, i) => { this.adj[e.a].push(i); this.adj[e.b].push(i); });
    // inNet[i] = 1 when node i belongs to a connected piece big enough to travel on
    // (or to the biggest piece, so a small map still has a network)
    this.inNet = new Uint8Array(lons.length);
    const seen = new Uint8Array(lons.length);
    const pieces = this.pieces = [];
    this.pieceOf = new Int32Array(lons.length); // LocalRouter.explain names the piece a failed leg sits on
    for (let i = 0; i < lons.length; i++) {
      if (seen[i]) continue;
      const stack = [i], piece = [];
      seen[i] = 1;
      while (stack.length) {
        const u = stack.pop();
        piece.push(u);
        this.pieceOf[u] = pieces.length;
        for (const ei of this.adj[u]) {
          const v = this.edges[ei].a === u ? this.edges[ei].b : this.edges[ei].a;
          if (!seen[v]) { seen[v] = 1; stack.push(v); }
        }
      }
      pieces.push(piece);
    }
    const biggest = pieces.reduce((m, p) => (p.length > m ? p.length : m), 0);
    for (const piece of pieces)
      if (piece.length >= NET_MIN_NODES || piece.length === biggest) for (const u of piece) this.inNet[u] = 1;
    this.plainDist = new Map(); // source node -> Float64Array of shortest lengths
    this.plainToDist = new Map(); // target node -> Float64Array of shortest lengths from every node to it
    this.ver = 0;
    this.builtStamp = stamp;
    this.buildMs = Date.now() - t0;
  };

  GraphPlanner.prototype._fresh = function (e) { return this.spentVer[e] < this.ver ? this.reward[e] : 0; };

  // How fogged the streets within rM of a point still are, 0..1. Where this is
  // high the ground is mostly virgin and planning is pointless: any wide loop
  // defogs near the ceiling, and benchmarks showed simple compass squares beat
  // planned walks there. Planning pays off where the surroundings are picked
  // over and the remaining fog is structured (measured: 0.57-0.74 at starts
  // where plans won, 0.89-0.94 where they lost; note even fully-walked streets
  // score ~0.3-0.5 because the recorded fog corridor is narrower than ours).
  GraphPlanner.prototype.meanFracNear = function (latlng, rM) {
    this.build();
    const px = latlng.lng * this.kx, py = latlng.lat * this.ky;
    let r = 0, l = 0;
    for (let i = 0; i < this.edges.length; i++) {
      const c = this.edges[i].coords[0];
      const dx = c[0] * this.kx - px, dy = c[1] * this.ky - py;
      if (dx * dx + dy * dy > rM * rM) continue;
      r += this.reward[i]; l += this.edges[i].len;
    }
    return l ? r / (l * CORRIDOR_M) : 1;
  };

  // Spend an edge's reward, and that of parallel edges whose corridor largely
  // overlaps (both sides of the same street, a footway hugging a road).
  GraphPlanner.prototype._spend = function (e) {
    this.spentVer[e] = this.ver;
    const g = this.midGrid;
    const edge = this.edges[e];
    for (let i = 1; i < edge.coords.length; i++) {
      const x = ((edge.coords[i - 1][0] + edge.coords[i][0]) / 2) * this.kx;
      const y = ((edge.coords[i - 1][1] + edge.coords[i][1]) / 2) * this.ky;
      for (let gy = -1; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) {
        const cell = g.get((Math.floor(x / 100) + gx) + "," + (Math.floor(y / 100) + gy));
        if (!cell) continue;
        for (const p of cell) {
          if (p.e === e || this.spentVer[p.e] >= this.ver) continue;
          if ((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < PARALLEL_M * PARALLEL_M) this.spentVer[p.e] = this.ver;
        }
      }
    }
  };

  // Can the edge be left from node u (one-ways only open at their entry end)? With
  // reverse, can it be entered at u: the search then runs against the direction of travel.
  GraphPlanner.prototype.canLeave = function (e, u, reverse) {
    return !e.dir || (e.dir > 0 === !reverse ? e.a : e.b) === u;
  };

  GraphPlanner.prototype._dijkstra = function (src, costFn, reverse) {
    const N = this.lons.length;
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    dist[src] = 0;
    const h = new Heap();
    h.push(src, 0);
    while (!h.empty()) {
      const { node: u, dist: du } = h.pop();
      if (du > dist[u]) continue;
      for (const ei of this.adj[u]) {
        const e = this.edges[ei];
        if (!this.canLeave(e, u, reverse)) continue;
        const v = e.a === u ? e.b : e.a;
        const nd = du + costFn(ei);
        if (nd < dist[v]) { dist[v] = nd; prev[v] = ei; h.push(v, nd); }
      }
    }
    return { dist, prev };
  };

  // Shortest length from every node TO dst (differs from _plain(dst) across one-ways).
  GraphPlanner.prototype._plainTo = function (dst) {
    let d = this.plainToDist.get(dst);
    if (!d) { d = this._dijkstra(dst, (ei) => this.edges[ei].len, true).dist; this.plainToDist.set(dst, d); }
    return d;
  };

  GraphPlanner.prototype._plain = function (src) {
    let d = this.plainDist.get(src);
    if (!d) { d = this._dijkstra(src, (ei) => this.edges[ei].len).dist; this.plainDist.set(src, d); }
    return d;
  };

  // Shortest path that would rather run along rewarding streets: fresh reward
  // discounts an edge's cost (never below 35%), so the metric stays positive.
  // Edges this plan has already walked cost extra, pushing the way back onto
  // different streets; that is what keeps loops loops instead of out-and-backs.
  GraphPlanner.prototype._richPath = function (u, v) {
    const { dist, prev } = this._dijkstra(u, (ei) => {
      const e = this.edges[ei];
      if (this.usedVer[ei] >= this.ver) return e.len * REUSE_COST;
      const rate = this._fresh(ei) / e.len;
      return e.len * (1 - RICH_PULL * Math.min(1, rate / CORRIDOR_M));
    });
    if (!isFinite(dist[v])) return null;
    const edgeIds = [];
    for (let n = v; n !== u;) {
      const ei = prev[n];
      if (ei < 0) return null;
      edgeIds.push(ei);
      const e = this.edges[ei];
      n = e.a === n ? e.b : e.a;
    }
    edgeIds.reverse();
    let len = 0, gained = 0;
    const coords = [];
    let at = u;
    for (const ei of edgeIds) {
      this.walks.set(ei, (this.walks.get(ei) || 0) + 1);
      const e = this.edges[ei];
      const cs = e.a === at ? e.coords : e.coords.slice().reverse();
      for (const c of cs) {
        if (!coords.length || coords[coords.length - 1][0] !== c[0] || coords[coords.length - 1][1] !== c[1]) coords.push(c);
      }
      len += e.len;
      gained += this._fresh(ei);
      this._spend(ei);
      this.usedVer[ei] = this.ver;
      at = e.a === at ? e.b : e.a;
    }
    return { coords, len, gained };
  };

  // Nearest node with at least minDeg edges within maxM, preferring nodes on a real
  // network: one in a stray fragment (courtyard, station) only counts when no network
  // node is in reach, so a pin beside a fragment still starts on the street map.
  GraphPlanner.prototype.snap = function (latlng, maxM, minDeg) {
    let best = -1, bd = maxM * maxM, any = -1, ad = bd;
    for (let i = 0; i < this.lons.length; i++) {
      if (this.adj[i].length < minDeg) continue;
      const dx = (this.lons[i] - latlng.lng) * this.kx, dy = (this.lats[i] - latlng.lat) * this.ky;
      const d = dx * dx + dy * dy;
      if (d < ad) { ad = d; any = i; }
      if (d < bd && this.inNet[i]) { bd = d; best = i; }
    }
    return best >= 0 ? best : any;
  };

  // Plans start on proper intersections: a dead-end start makes every plan begin with a spur.
  GraphPlanner.prototype.nearestNode = function (latlng, maxM) { return this.snap(latlng, maxM || 600, 2); };

  // Rewarding way clusters on a coarse grid: what the plan visits. A pocket's
  // worth is its defoggable area WEIGHTED BY PURITY (the still-fogged share of
  // its ways): a sparse forest cell where every metre walked collects at full
  // rate must not lose to a big urban cell whose mass is half-cleared fringe.
  // Raw mass measures how much is there; purity measures how honestly a route
  // through it collects. (Field case: the Dresdner Heide never seeded a plan
  // because its path cells lost every raw-mass comparison to city fringe.)
  GraphPlanner.prototype._pockets = function () {
    const cells = new Map();
    this.edges.forEach((e, i) => {
      const r = this.reward[i];
      if (r <= 0) return;
      const mid = e.coords[Math.floor(e.coords.length / 2)];
      const key = Math.floor(mid[0] * this.kx / POCKET_GRID_M) + "," + Math.floor(mid[1] * this.ky / POCKET_GRID_M);
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { m2: 0, lenM: 0, bestR: -1, node: -1, px: 0, py: 0 }));
      c.m2 += r;
      c.lenM += e.len;
      if (r > c.bestR) { c.bestR = r; c.node = e.a; c.px = mid[0] * this.kx; c.py = mid[1] * this.ky; }
    });
    const out = [...cells.values()].filter((c) => c.m2 >= POCKET_MIN_M2);
    // value weights defoggable mass by purity (the still-fogged share of the
    // pocket's ways), so a sparse-but-virgin forest cell competes with a big
    // half-cleared city cell instead of always losing on raw mass. This does
    // NOT cost dense home areas: their top pockets are the same either way
    // (verified: Neustadt unchanged); it only lets pure outliers seed a plan.
    for (const c of out) c.value = c.m2 * Math.min(1, c.m2 / (c.lenM * CORRIDOR_M));
    return out.sort((a, b) => b.value - a.value).slice(0, MAX_POCKETS);
  };

  GraphPlanner.prototype._plainLen = function (anchors, cyclic) {
    let L2 = 0;
    for (let i = 1; i < anchors.length; i++) L2 += this._plain(anchors[i - 1])[anchors[i]];
    if (cyclic) L2 += this._plain(anchors[anchors.length - 1])[anchors[0]];
    return L2;
  };

  // Insert the single best pocket (richest per metre of detour) whose plain
  // detour cost fits maxCostM. Returns the inserted node, or null.
  GraphPlanner.prototype._growOne = function (anchors, cyclic, maxCostM, pockets, used) {
    if (anchors.length >= MAX_ANCHORS) return null;
    let best = null;
    for (const p of pockets) {
      if (used.has(p) || p.node < 0) continue;
      const gaps = anchors.length - (cyclic ? 0 : 1);
      for (let g = 0; g < gaps; g++) {
        const u = anchors[g], v = anchors[(g + 1) % anchors.length];
        const cost = this._plain(u)[p.node] + this._plain(p.node)[v] - this._plain(u)[v];
        if (!isFinite(cost) || cost > maxCostM) continue;
        const ratio = p.value / Math.max(cost, 150);
        if (!best || ratio > best.ratio) best = { p, g, ratio };
      }
    }
    if (!best) return null;
    anchors.splice(best.g + 1, 0, best.p.node);
    used.add(best.p);
    return best.p.node;
  };

  GraphPlanner.prototype._materialize = function (anchors, cyclic) {
    this.ver++;
    this.walks = new Map();
    const seq = cyclic ? anchors.concat([anchors[0]]) : anchors;
    let coords = [], len = 0, gained = 0;
    for (let i = 1; i < seq.length; i++) {
      const leg = this._richPath(seq[i - 1], seq[i]);
      if (!leg) return null;
      coords = coords.length ? coords.concat(leg.coords.slice(1)) : leg.coords;
      len += leg.len; gained += leg.gained;
    }
    // metres on edges walked more than once, both passes counted (as overlapFrac does)
    let twice = 0;
    for (const [ei, n] of this.walks) if (n > 1) twice += this.edges[ei].len * n;
    return { coords, len, gained, retraceFrac: len ? Math.min(1, twice / len) : 0 };
  };

  function resampleWps(coords, n, kx, ky) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++)
      cum.push(cum[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * kx, (coords[i][1] - coords[i - 1][1]) * ky));
    const total = cum[cum.length - 1];
    const out = [];
    let k = 1;
    for (let t = 1; t <= n; t++) {
      const target = total * t / (n + 1);
      while (k < cum.length - 1 && cum[k] < target) k++;
      out.push(L.latLng(coords[k][1], coords[k][0]));
    }
    return out;
  }

  // Plan up to nCands loops from S of roughly distM. Each result:
  // { wps (editor pins, S first and last), coords ([lon,lat] street path), predM2, lenM }
  GraphPlanner.prototype.planLoop = function (S, distM, buffer, nCands) {
    this.build();
    const s = this.nearestNode(S, 600);
    if (s < 0) return [];
    const pockets = this._pockets();
    if (!pockets.length) return [];
    const dS = this._plain(s);
    const dBack = this._plainTo(s); // the way home can differ from the way out across one-ways
    const reach = pockets.filter((p) => p.node >= 0 && dS[p.node] <= distM * (1 + buffer) * 0.5 && dBack[p.node] <= distM * (1 + buffer) * 0.5);
    // seeds are a UNION of two strategies. First, the richest pockets spread
    // apart (the original approach): this fields a dense area's strong loops,
    // which one-per-sector alone dropped (cost Neustadt ~18%). Second, the
    // best pocket in each 60-degree sector not already covered: this gives
    // every direction, forest and river included, a trial it would otherwise
    // lose to the dense half of the compass. The honest ranking of the
    // finished loops decides between them.
    const seeds = [];
    for (const p of reach) {
      if (seeds.length >= nCands + 2) break;
      if (seeds.every((q) => Math.hypot(q.px - p.px, q.py - p.py) > distM * 0.12)) seeds.push(p);
    }
    const sx = S.lng * this.kx, sy = S.lat * this.ky;
    const bySector = new Map();
    for (const p of reach) {
      const sector = Math.floor((((Math.atan2(p.px - sx, p.py - sy) * 180 / Math.PI) + 360) % 360) / 60);
      const cur = bySector.get(sector);
      if (!cur || p.value > cur.value) bySector.set(sector, p);
    }
    for (const p of [...bySector.values()].sort((a, b) => b.value - a.value)) {
      if (seeds.length >= nCands + 4) break;
      if (!seeds.includes(p)) seeds.push(p);
    }
    const out = [];
    // aim 7% past the requested distance (empirical offset)
    const target = distM * 1.07;
    const ceilG = distM * (1 + buffer) * 1.04;
    for (const seed of seeds) {
      const used = new Set([seed]);
      const anchors = [s, seed.node];
      const stack = []; // pockets in insertion order, so overshoot can undo
      let m = this._materialize(anchors, true);
      // insert pockets one at a time, re-walking the loop after each; the
      // detour allowance comes from the WALKED length's real headroom, scaled
      // by the learned plain-to-walked inflation (a global plain budget
      // starved growth and plans arrived short)
      for (let it = 0; it < MAX_ANCHORS && m && m.len < target * 0.96; it++) {
        const inflate = Math.min(1.4, Math.max(1.0, m.len / Math.max(1, this._plainLen(anchors, true))));
        const node = this._growOne(anchors, true, (ceilG - m.len) / inflate, reach, used);
        if (!node) break;
        const m2 = this._materialize(anchors, true);
        if (!m2) break;
        stack.push(node);
        m = m2;
      }
      // repair an overshooting loop: drop pockets until it fits under emitCeil,
      // which is looser than the tolerance (the best loops live at the edge).
      // Pockets are coarse, so a plain drop usually undershoots; after each
      // drop, try to re-add a smaller pocket that fits the space.
      const emitCeil = distM * (1 + buffer) * 1.12;
      for (let r = 0; r < 4 && m && m.len > emitCeil && stack.length; r++) {
        anchors.splice(anchors.indexOf(stack.pop()), 1);
        let m2 = this._materialize(anchors, true);
        if (!m2) { m = null; break; }
        if (m2.len < target * 0.96) {
          const inflate = Math.min(1.4, Math.max(1.0, m2.len / Math.max(1, this._plainLen(anchors, true))));
          const node = this._growOne(anchors, true, (emitCeil - m2.len) / inflate, reach, used);
          if (node) {
            const m3 = this._materialize(anchors, true);
            if (m3) { stack.push(node); m2 = m3; }
          }
        }
        m = m2;
      }
      // same empirical 1.07 on the floor; the ceiling is emitCeil
      if (!m || m.len < distM * (1 - buffer) * 1.07 || m.len > emitCeil) continue;
      // editor pins: ~550 m apart keeps a later re-route on the plan's streets
      const nWps = Math.min(20, Math.max(6, Math.round(m.len / 550)));
      // sector of the loop's farthest reach from S, for direction-diverse emit
      let fx = 0, fy = 0, fd = -1;
      for (const c of m.coords) {
        const dx = c[0] * this.kx - sx, dy = c[1] * this.ky - sy;
        if (dx * dx + dy * dy > fd) { fd = dx * dx + dy * dy; fx = dx; fy = dy; }
      }
      const sector = Math.floor((((Math.atan2(fx, fy) * 180 / Math.PI) + 360) % 360) / 90);
      out.push({
        wps: [S].concat(resampleWps(m.coords, nWps, this.kx, this.ky), [S]),
        coords: [[S.lng, S.lat]].concat(m.coords, [[S.lng, S.lat]]),
        predM2: m.gained, lenM: m.len, sector
      });
    }
    out.sort((a, b) => b.predM2 - a.predM2);
    const deduped = dedupePlans(out);
    // emit a direction-diverse set by round-robin across 90-degree sectors:
    // each direction's best plan is taken before any direction's second, so a
    // single rich direction can't fill every slot and a real alternative (a
    // forest, a riverside) is put in front of the ranking. The
    // global best is still taken first, so the top card never weakens.
    const bySec = new Map();
    for (const p of deduped) { const g = bySec.get(p.sector) || []; g.push(p); bySec.set(p.sector, g); }
    const groups = [...bySec.values()]; // each already sorted (deduped kept pred order)
    const diverse = [];
    for (let round = 0; diverse.length < deduped.length; round++) {
      const layer = groups.filter((g) => g[round]).map((g) => g[round]);
      layer.sort((a, b) => b.predM2 - a.predM2);
      diverse.push(...layer);
    }
    return diverse.slice(0, nCands);
  };

  // Different seeds can converge onto the same loop once insertion fills in
  // the rest; near-identical (length, reward) pairs are the same plan.
  function dedupePlans(plans) {
    const seen = new Set(), out = [];
    for (const p of plans) {
      const key = Math.round(p.lenM / 150) + ":" + Math.round(p.predM2 / 1500);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }

  // Plan up to nCands A-to-B walks within budgetM.
  GraphPlanner.prototype.planP2P = function (A, B, budgetM, nCands) {
    this.build();
    const a = this.nearestNode(A, 600), b = this.nearestNode(B, 600);
    if (a < 0 || b < 0) return [];
    const pockets = this._pockets();
    const dA = this._plain(a), dB = this._plainTo(b);
    if (!isFinite(dA[b])) return [];
    const reach = pockets.filter((p) => p.node >= 0 && isFinite(dA[p.node]) && isFinite(dB[p.node]) &&
      dA[p.node] + dB[p.node] <= budgetM * 0.95);
    const out = [];
    const tried = new Set();
    for (let v = 0; v < nCands + 2 && v < Math.max(1, reach.length); v++) {
      const seed = reach[v];
      const key = seed ? seed.node : -1;
      if (tried.has(key)) continue;
      tried.add(key);
      const used = seed ? new Set([seed]) : new Set();
      const anchors = seed ? [a, seed.node, b] : [a, b];
      let m = this._materialize(anchors, false);
      const ceilW = budgetM * 1.03; // slight overhang ok
      for (let it = 0; it < MAX_ANCHORS && m && m.len < budgetM * 0.97; it++) {
        const inflate = Math.min(1.4, Math.max(1.0, m.len / Math.max(1, this._plainLen(anchors, false))));
        if (!this._growOne(anchors, false, (ceilW - m.len) / inflate, reach, used)) break;
        const m2 = this._materialize(anchors, false);
        if (!m2) break;
        m = m2;
      }
      if (!m || m.len > budgetM * 1.1) continue;
      const nWps = Math.min(16, Math.max(2, Math.round(m.len / 550)));
      out.push({
        wps: [A].concat(resampleWps(m.coords, nWps, this.kx, this.ky), [B]),
        coords: [[A.lng, A.lat]].concat(m.coords, [[B.lng, B.lat]]),
        predM2: m.gained, lenM: m.len, retraceFrac: m.retraceFrac
      });
      if (out.length >= nCands + 1) break;
    }
    const score = (p) => p.predM2 * (1 - RETRACE_WEIGHT * p.retraceFrac);
    out.sort((x, y) => score(y) - score(x));
    return dedupePlans(out).slice(0, nCands);
  };

  GraphPlanner.Heap = Heap; // LocalRouter's point-to-point search
  global.GraphPlanner = GraphPlanner;
})(window);
