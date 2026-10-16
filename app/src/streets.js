// Street-aware reward data for route suggestions.
// Fetches street geometry for small areas from Overpass (OpenStreetMap) and
// answers one question: how much AREA could still be defogged by travelling
// the ways within reach of a point? Each way segment is weighted by the share
// of its ~30 m corridor that is still fogged, so a lone path through virgin
// meadow (huge corridor gain) outscores its low street-metre count, and a
// half-rewalked grid doesn't get overcounted. Raw fog alone can't tell a
// street grid from a lake; street metres alone can't tell a rich meadow path
// from a rewalked alley. Privacy: Overpass only ever sees bounding boxes, the
// same class of information the basemap tile servers already get. The fog
// itself never leaves the device (segments are scored against it locally).
(function (global) {
  const OVERPASS = "https://overpass-api.de/api/interpreter";
  // Streets someone would plausibly cover on foot vs on a bike. Driveways and
  // parking aisles are excluded: they're numerous and nobody hunts them.
  // Besides what people cover, the lists hold trunk roads, link roads and (on foot) steps:
  // routing needs their junctions, or side streets that reach the network only through
  // a main road are cut off
  const RUN_HW = "residential|unclassified|tertiary|secondary|primary|trunk|living_street|track|path|footway|cycleway|pedestrian|steps|primary_link|secondary_link|tertiary_link|trunk_link";
  const BIKE_HW = "residential|unclassified|tertiary|secondary|primary|trunk|living_street|cycleway|track|primary_link|secondary_link|tertiary_link|trunk_link";
  // Which of the walked ways each other way of travelling can actually use. A
  // walking fetch also asks for these as bare ID LISTS (a few hundred KB, versus
  // about a megabyte if we asked Overpass for the tags), so the map can dim the
  // ways the chosen transport can't take without fetching anything again.
  const CLASS_HW = {
    bike: "residential|unclassified|tertiary|secondary|primary|living_street|cycleway|track|path|trunk|primary_link|secondary_link|tertiary_link|trunk_link",
    road: "residential|unclassified|tertiary|secondary|primary|living_street|cycleway|trunk|primary_link|secondary_link|tertiary_link|trunk_link",
    car: "residential|unclassified|tertiary|secondary|primary|living_street|trunk|primary_link|secondary_link|tertiary_link|trunk_link"
  };
  const CLASS_ORDER = ["bike", "road", "car"]; // the order the ID lists come back in
  // routing profile -> travel class; the same table as streetsLayer's MODE_CLASS,
  // keep them in step. Unlisted profiles (hiking-mountain, rail, shortest) use every way.
  const MODE_CLASS = { trekking: "bike", fastbike: "road", "car-fast": "car" };
  const SEG_M = 50;              // ways are chopped into ~50 m scoring segments
  const GRID_M = 250;            // spatial bin size for radius queries
  const MAX_SEGS = 400000;       // memory guard (~40 MB worst case)
  const CORRIDOR_M = 30;         // full width Fog of World clears as you travel

  function StreetIndex(opts) {
    this.newFrac = opts.newFrac; // (lon,lat) -> 0..1 share of the corridor stamp still fogged
    this.segs = new Map();       // "gx,gy" -> [{x,y,lon,lat,lenM,frac}]
    this.rects = [];             // fetched coverage, [{s,w,n,e}]
    this.wayIds = new Set();     // dedupe across overlapping fetches
    this.classIds = { bike: new Set(), road: new Set(), car: new Set() };
    this.classified = new Set(); // ways we know the travel classes of (blank = assume usable)
    this.oneWay = new Set();     // one-way along the way's node order (incl. roundabouts)
    this.reverseWay = new Set(); // one-way against it (oneway=-1)
    this.ways = [];              // raw {id,nodes,geometry}: shared node ids give the
                                 // route planner its graph connectivity for free
    this.segCount = 0;
    this.kx = null; this.ky = 110540; // metre frame, anchored on first fetch
  }

  StreetIndex.prototype._anchor = function (lat) {
    if (this.kx === null) this.kx = 111320 * Math.cos(lat * Math.PI / 180);
  };

  StreetIndex.prototype.covered = function (lat, lng) {
    return this.rects.some((r) => lat >= r.s && lat <= r.n && lng >= r.w && lng <= r.e);
  };

  StreetIndex.prototype._addWay = function (w) {
    if (!w.geometry || w.geometry.length < 2 || this.wayIds.has(w.id)) return;
    this.wayIds.add(w.id);
    if (w.nodes && w.nodes.length === w.geometry.length) this.ways.push({ id: w.id, nodes: w.nodes, geometry: w.geometry });
    for (let i = 1; i < w.geometry.length && this.segCount < MAX_SEGS; i++) {
      const a = w.geometry[i - 1], b = w.geometry[i];
      const ax = a.lon * this.kx, ay = a.lat * this.ky;
      const bx = b.lon * this.kx, by = b.lat * this.ky;
      const edgeM = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(edgeM / SEG_M));
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        const key = Math.floor(x / GRID_M) + "," + Math.floor(y / GRID_M);
        let cell = this.segs.get(key);
        if (!cell) this.segs.set(key, (cell = []));
        cell.push({ x, y, lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t, lenM: edgeM / n, frac: null });
        this.segCount++;
      }
    }
  };

  // A rect counts as covered when an earlier fetch contains it AND fetched at
  // least the streets asked for now: the walking set is a superset of the bike
  // set, so a "run" fetch satisfies a later "bike" request but not vice versa.
  StreetIndex.prototype._uncovered = function (rects, kind) {
    return rects.filter((r) =>
      !this.rects.some((o) => r.s >= o.s && r.n <= o.n && r.w >= o.w && r.e <= o.e &&
        (o.kind === "run" || o.kind === kind)));
  };

  // Would ensureRects actually hit the network for these, or is it
  // all already cached from an earlier run? Lets callers show the "reading the
  // street map" note only when there's a real fetch, not on every rerun.
  StreetIndex.prototype.needsFetch = function (rects, kind) { return this._uncovered(rects, kind).length > 0; };

  // Which way a routing profile may travel each way: 1 along its node order only, -1
  // against it, 0 both. One-ways bind the profiles on wheels, not walking, rail or the
  // straight line.
  StreetIndex.prototype.onewayFor = function (profile) {
    if (!MODE_CLASS[profile]) return () => 0;
    return (id) => (this.oneWay.has(id) ? 1 : this.reverseWay.has(id) ? -1 : 0);
  };

  // Which ways a routing profile may use, by the same rule streetsLayer dims
  // them with. A way we hold no class for (a bike-kind fetch) counts as usable.
  StreetIndex.prototype.usableFor = function (profile) {
    const cls = MODE_CLASS[profile];
    if (!cls) return () => true;
    return (id) => !this.classified.has(id) || this.classIds[cls].has(id);
  };

  // Round a point to a ~0.006 degree grid (~450-650 m). Callers build the fetch
  // area around the rounded centre, so any run whose pin lands in the same grid
  // cell produces the identical area and reuses the cache: pressing Suggest
  // again, or after a small pin nudge, doesn't trigger a fresh download. The
  // fetch area's own margin (hundreds of metres) absorbs the rounding offset.
  StreetIndex.prototype.snapPoint = function (latlng, g) {
    g = g || 0.006;
    return L.latLng(Math.round(latlng.lat / g) * g, Math.round(latlng.lng / g) * g);
  };

  // Fetch streets for the given rects (skipping ones already covered), one
  // Overpass query. kind: "run" | "bike". Throws on failure; suggestions end in
  // their error state, since routing needs the streets.
  StreetIndex.prototype.ensureRects = async function (rects, kind) {
    const todo = this._uncovered(rects, kind);
    if (!todo.length) return;
    this._anchor(todo[0].s);
    const bb = (r) => [r.s, r.w, r.n, r.e].map((x) => x.toFixed(4)).join(",");
    // access filter: planned and routed walks must not cross ways the person
    // can't use
    const acc = `[access!~"^(private|no|military)$"]`;
    const clauses = (hw) => todo.map((r) =>
      `way[highway~"^(${hw})$"]${acc}(${bb(r)});way[highway=service]${acc}[service!~"^(driveway|parking_aisle)$"](${bb(r)});`).join("");
    let q = `[out:json][timeout:60];(${clauses(kind === "bike" ? BIKE_HW : RUN_HW)});out skel geom;`;
    // Ask a walking fetch for the travel-class ID lists too. Each list is
    // introduced by its own count, so the groups stay apart in one response.
    const lists = [];
    if (kind !== "bike")
      for (const k of CLASS_ORDER) { lists.push(k); q += `(${clauses(CLASS_HW[k])})->.${k};.${k} out count;.${k} out ids;`; }
    // and the one-way ID lists (a way travelled one way, a roundabout, one travelled against its order)
    const hw = kind === "bike" ? BIKE_HW : RUN_HW;
    const tagged = (f) => todo.map((r) => `way[highway~"^(${hw})$"]${acc}${f}(${bb(r)});`).join("");
    for (const [k, f] of [["oneWay", `[oneway~"^(yes|true|1)$"]`], ["reverseWay", `[oneway~"^(-1|reverse)$"]`]]) {
      lists.push(k);
      q += `(${tagged(f)}${k === "oneWay" ? todo.map((r) => `way[highway~"^(${hw})$"]${acc}[junction=roundabout][oneway!=no](${bb(r)});`).join("") : ""})->.${k};.${k} out count;.${k} out ids;`;
    }
    const res = await fetch(OVERPASS, {
      method: "POST",
      // UA is for the Node benchmark harness (Overpass rejects Node's default);
      // browsers filter the header out as forbidden, which is fine.
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "FogToMaps/1.0 (defog route suggestions)" },
      body: "data=" + encodeURIComponent(q)
    });
    if (!res.ok) throw new Error("overpass HTTP " + res.status);
    const gj = await res.json();
    let group = -1; // -1 = the geometry, then one list (see `lists`) per count marker
    for (const el of gj.elements || []) {
      if (el.type === "count") { group++; continue; }
      if (el.type !== "way") continue;
      if (group < 0) { this._addWay(el); if (kind !== "bike") this.classified.add(el.id); }
      else if (this.classIds[lists[group]]) this.classIds[lists[group]].add(el.id);
      else if (this[lists[group]]) this[lists[group]].add(el.id);
    }
    for (const r of todo) this.rects.push({ s: r.s, w: r.w, n: r.n, e: r.e, kind });
  };

  // Defoggable area (m²) reachable by travelling the ways within rM of the
  // point: sum of segment length x corridor width x still-fogged share of the
  // corridor. Segments are scored against the fog lazily and cached (the fog
  // is static while planning). Only meaningful where covered() is true.
  StreetIndex.prototype.newAreaM2 = function (latlng, rM) {
    if (this.kx === null) return 0;
    const px = latlng.lng * this.kx, py = latlng.lat * this.ky;
    const g0x = Math.floor((px - rM) / GRID_M), g1x = Math.floor((px + rM) / GRID_M);
    const g0y = Math.floor((py - rM) / GRID_M), g1y = Math.floor((py + rM) / GRID_M);
    const r2 = rM * rM;
    let m2 = 0;
    for (let gy = g0y; gy <= g1y; gy++) for (let gx = g0x; gx <= g1x; gx++) {
      const cell = this.segs.get(gx + "," + gy);
      if (!cell) continue;
      for (const s of cell) {
        const dx = s.x - px, dy = s.y - py;
        if (dx * dx + dy * dy > r2) continue;
        if (s.frac === null) s.frac = this.newFrac(s.lon, s.lat);
        // linear frac deliberately: sqrt (softer on rewalked grids) and raw
        // street metres both benchmarked worse; length x fogged-share is also
        // exactly the quantity computeGain rewards
        m2 += s.lenM * CORRIDOR_M * s.frac;
      }
    }
    return m2;
  };

  global.StreetIndex = StreetIndex;
})(window);
