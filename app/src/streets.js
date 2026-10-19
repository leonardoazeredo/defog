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
  // Streets someone would plausibly cover on foot vs on a bike. Driveways and
  // parking aisles are excluded: they're numerous and nobody hunts them.
  // Besides what people cover, the lists hold trunk roads, link roads and (on foot) steps:
  // routing needs their junctions, or side streets that reach the network only through
  // a main road are cut off
  const CONNECT_HW = "trunk|trunk_link|primary_link|secondary_link|tertiary_link";
  const RUN_HW = "residential|unclassified|tertiary|secondary|primary|living_street|track|path|footway|cycleway|pedestrian|steps|" + CONNECT_HW;
  const BIKE_HW = "residential|unclassified|tertiary|secondary|primary|living_street|cycleway|track|" + CONNECT_HW;
  const CAR_HW = "residential|unclassified|tertiary|secondary|primary|living_street|motorway|motorway_link|" + CONNECT_HW;
  // Which of the walked ways each other way of travelling can actually use. A
  // fetch also asks for these as bare ID LISTS (a few hundred KB, versus
  // about a megabyte if we asked Overpass for the tags), so the map can dim the
  // ways the chosen transport can't take without fetching anything again.
  const CLASS_HW = {
    bike: "residential|unclassified|tertiary|secondary|primary|living_street|cycleway|track|path|" + CONNECT_HW,
    road: "residential|unclassified|tertiary|secondary|primary|living_street|cycleway|" + CONNECT_HW,
    car: "residential|unclassified|tertiary|secondary|primary|living_street|motorway|motorway_link|" + CONNECT_HW
  };
  const CLASS_ORDER = ["bike", "road", "car"]; // the travel classes, first in GROUP_ORDER
  // every ID list a fetch asks for, in the order the answer carries them after the geometry
  const GROUP_ORDER = CLASS_ORDER.concat(["oneWay", "reverseWay", "bikeBoth", "motorway"]);
  // routing profile -> travel class (also read by streetsLayer for its dimming).
  // Unlisted profiles (hiking-mountain, rail, shortest) use every way.
  const MODE_CLASS = { trekking: "bike", fastbike: "road", "car-fast": "car" };
  const SEG_M = 50;              // ways are chopped into ~50 m scoring segments
  const GRID_M = 250;            // spatial bin size for radius queries
  const MAX_SEGS = 400000;       // memory guard (~40 MB worst case)
  const CORRIDOR_M = 30;         // full width Fog of World clears as you travel
  const TILE_DEG = 0.05;         // fetch grid, ~5.5 x 3.5 km at 51°N: streets are fetched and remembered per tile
  const TILE_EPS = 1e-9;         // in tiles: keeps a bound that sits on a tile edge from reaching into the neighbouring tile

  function StreetIndex(opts) {
    this.newFrac = opts.newFrac; // (lon,lat) -> 0..1 share of the corridor stamp still fogged
    this.fetchStreets = opts.fetchStreets || StreetIndex.overpassFetch; // the street source: (tiles, kind) -> Map "x:y" -> answer
    this.segs = new Map();       // "gx,gy" -> [{x,y,lon,lat,lenM,frac}]
    this.tiles = new Set();      // fetched coverage, StreetIndex.tileKey(kind, x, y)
    this.wayIds = new Set();     // dedupe across overlapping fetches
    this.classIds = { bike: new Set(), road: new Set(), car: new Set() };
    this.classified = new Set(); // ways we know the travel classes of (blank = assume usable)
    this.oneWay = new Set();     // one-way along the way's node order (incl. roundabouts)
    this.reverseWay = new Set(); // one-way against it (oneway=-1)
    this.bikeBoth = new Set();   // one-way streets bikes may still ride both ways (contraflow lanes)
    this.motorway = new Set();   // motorways and their links: cars only (fetched for cars only)
    this.ways = [];              // raw {id,nodes,geometry}: shared node ids give the
                                 // route planner its graph connectivity for free
    this.segCount = 0;
    this.version = 0;            // bumped by every fetch that was read, so graphs built from this notice list changes
    this.kx = null; this.ky = 110540; // metre frame, anchored on first fetch
  }

  StreetIndex.prototype._anchor = function (lat) {
    if (this.kx === null) this.kx = 111320 * Math.cos(lat * Math.PI / 180);
  };

  StreetIndex.prototype.covered = function (lat, lng) {
    const t = StreetIndex.tileOf(lng, lat);
    return ["run", "bike", "car"].some((k) => this.tiles.has(StreetIndex.tileKey(k, t.x, t.y)));
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

  // A tile counts as covered when it was fetched for the same kind AND fetched at
  // least the streets asked for now: the walking set is a superset of the bike
  // set, so a "run" fetch satisfies a later "bike" request but not vice versa. A car
  // fetch holds motorways, which nothing else does, so only a car fetch covers cars.
  StreetIndex.prototype._uncovered = function (rects, kind) {
    const seen = new Set();
    return rects.flatMap((r) => StreetIndex.tilesCovering(r)).filter((t) => {
      const k = t.x + ":" + t.y;
      if (seen.has(k)) return false;
      seen.add(k);
      return !(this.tiles.has(StreetIndex.tileKey(kind, t.x, t.y)) ||
        (kind !== "car" && this.tiles.has(StreetIndex.tileKey("run", t.x, t.y))));
    });
  };

  StreetIndex.prototype._cover = function (tiles, kind) {
    for (const t of tiles) this.tiles.add(StreetIndex.tileKey(kind, t.x, t.y));
  };

  // Would ensureRects actually hit the network for these, or is it
  // all already cached from an earlier run? Lets callers show the "reading the
  // street map" note only when there's a real fetch, not on every rerun.
  StreetIndex.prototype.needsFetch = function (rects, kind) { return this._uncovered(rects, kind).length > 0; };

  // Which way a routing profile may travel each way: 1 along its node order only, -1
  // against it, 0 both. One-ways bind the profiles on wheels, not walking, rail or the
  // straight line; bikes are exempt where a contraflow lane is tagged.
  StreetIndex.prototype.onewayFor = function (profile) {
    const cls = MODE_CLASS[profile];
    if (!cls) return () => 0;
    const bike = cls === "bike" || cls === "road";
    return (id) => (bike && this.bikeBoth.has(id) ? 0 : this.oneWay.has(id) ? 1 : this.reverseWay.has(id) ? -1 : 0);
  };

  // Which ways a routing profile may use, by the same rule streetsLayer dims
  // them with. A way we hold no class for counts as usable. Motorways are in the shared
  // way list once a car fetch has run, and only cars may use them.
  StreetIndex.prototype.usableFor = function (profile) {
    const cls = MODE_CLASS[profile];
    if (!cls) return (id) => !this.motorway.has(id);
    if (cls === "car") return (id) => !this.classified.has(id) || this.classIds.car.has(id);
    return (id) => !this.motorway.has(id) && (!this.classified.has(id) || this.classIds[cls].has(id));
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

  // Fetch streets for the tiles under the given rects (skipping ones already covered),
  // in one call to the street source. kind: "run" | "bike" | "car". Throws on failure;
  // suggestions end in their error state, since routing needs the streets.
  StreetIndex.prototype.ensureRects = async function (rects, kind) {
    const todo = this._uncovered(rects, kind);
    if (!todo.length) return;
    this._anchor(rects[0].s);
    const answers = await this.fetchStreets(todo, kind);
    for (const t of todo) {
      const answer = answers.get(t.x + ":" + t.y);
      if (!answer) throw new Error("street source: no answer for a requested tile");
      for (const w of answer.ways) { this._addWay(w); this.classified.add(w.id); }
      for (const name of GROUP_ORDER) {
        const into = this.classIds[name] || this[name];
        for (const id of answer.groups[name] || []) into.add(id);
      }
    }
    this.version++;
    this._cover(todo, kind);
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

  StreetIndex.TILE_DEG = TILE_DEG;
  StreetIndex.tileOf = (lng, lat) => ({ x: Math.floor(lng / TILE_DEG), y: Math.floor(lat / TILE_DEG) });
  // A bound on a tile edge takes the tile on its inside (a west or south edge the tile it opens, an
  // east or north edge the tile it closes), so a tile's own bounds map back to it; a rect with
  // no width still takes one tile.
  StreetIndex.tilesCovering = ({ s, w, n, e }) => {
    const x0 = Math.floor(w / TILE_DEG + TILE_EPS), y0 = Math.floor(s / TILE_DEG + TILE_EPS);
    const x1 = Math.max(x0, Math.ceil(e / TILE_DEG - TILE_EPS) - 1), y1 = Math.max(y0, Math.ceil(n / TILE_DEG - TILE_EPS) - 1);
    const tiles = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ x, y });
    return tiles;
  };
  StreetIndex.tileBounds = ({ x, y }) => ({ s: y * TILE_DEG, w: x * TILE_DEG, n: (y + 1) * TILE_DEG, e: (x + 1) * TILE_DEG });
  StreetIndex.tileKey = (kind, x, y) => kind + ":" + x + ":" + y;

  // The Overpass query for the given boxes ([{s,w,n,e}]). The bench cache is keyed on this
  // text, so changing it makes every saved answer miss.
  StreetIndex.rectQuery = function (boxes, kind) {
    const bb = (r) => [r.s, r.w, r.n, r.e].map((x) => x.toFixed(4)).join(",");
    // access filter: planned and routed trips must not cross ways the person can't
    // use (motorroads are for motor vehicles; foot=no only matters on foot)
    const acc = `[access!~"^(private|no|military)$"]` + (kind === "car" ? "" : `[motorroad!=yes]`) + (kind === "run" ? `[foot!=no]` : "");
    const clauses = (hw) => boxes.map((r) =>
      `way[highway~"^(${hw})$"]${acc}(${bb(r)});way[highway=service]${acc}[service!~"^(driveway|parking_aisle)$"](${bb(r)});`).join("");
    const hw = kind === "bike" ? BIKE_HW : kind === "car" ? CAR_HW : RUN_HW;
    // the box is scanned once into .all; each list below filters that set (scanning the
    // box again per list ran Overpass out of time on a town-sized box)
    let q = `[out:json][timeout:60];(${clauses(hw)})->.all;.all out skel geom;`;
    const tagged = (list, filter) => `way.all[highway~"^(${list})$"]${filter};`;
    const withService = (list, filter) => tagged(list, filter) + `way.all[highway=service]${filter};`;
    // Then ID lists, each introduced by its own count so the groups stay apart in one
    // response: the travel classes (bikes keep off bicycle=no), the one-ways (a way
    // travelled one way, plus roundabouts, and one travelled against its node order),
    // the one-ways bikes may ride both ways, and the motorways.
    const groups = CLASS_ORDER.map((k) => [k, withService(CLASS_HW[k], k === "car" ? "" : "[bicycle!=no]")]).concat([
      ["oneWay", withService(hw, `[oneway~"^(yes|true|1)$"]`) + tagged(hw, `[junction=roundabout][oneway!=no]`)],
      ["reverseWay", withService(hw, `[oneway~"^(-1|reverse)$"]`)],
      ["bikeBoth", tagged(hw, `[~"^oneway:bicycle$"~"^no$"]`) + tagged(hw, `[cycleway~"^opposite"]`) + tagged(hw, `[~"^cycleway:(left|right|both)$"~"^opposite"]`)],
      ["motorway", tagged("motorway|motorway_link", "")]
    ]);
    for (const [k, body] of groups) q += `(${body})->.${k};.${k} out count;.${k} out ids;`;
    return q;
  };

  // The default street source: one Overpass request for all the tiles, the answer split per
  // tile. `boxes` replaces the tiles' own bounds in the query text (the bench sends the
  // query text its saved answers were fetched with, see bench/lib/tileFetch.js).
  StreetIndex.overpassFetch = async function (tiles, kind, boxes) {
    const gj = await global.Overpass.post("data=" + encodeURIComponent(StreetIndex.rectQuery(boxes || tiles.map(StreetIndex.tileBounds), kind)));
    // a timeout or out-of-memory still answers 200, with whatever it had by then
    if (gj.remark) throw new Error("overpass: " + gj.remark);
    const ways = [], groups = {};
    for (const name of GROUP_ORDER) groups[name] = [];
    let group = -1; // -1 = the geometry, then one list (see GROUP_ORDER) per count marker
    for (const el of gj.elements || []) {
      if (el.type === "count") { group++; continue; }
      if (el.type !== "way") continue;
      if (group < 0) ways.push({ id: el.id, nodes: el.nodes, geometry: el.geometry });
      else if (groups[GROUP_ORDER[group]]) groups[GROUP_ORDER[group]].push(el.id);
    }
    // a way goes to every requested tile holding one of its points, to the first when none does
    const answers = new Map(tiles.map((t) => [t.x + ":" + t.y, { ways: [], groups: Object.fromEntries(GROUP_ORDER.map((n) => [n, []])) }]));
    const home = new Map(); // way id -> the answers it went to
    for (const w of ways) {
      const hit = new Set();
      for (const p of w.geometry || []) {
        const t = StreetIndex.tileOf(p.lon, p.lat);
        const a = answers.get(t.x + ":" + t.y);
        if (a) hit.add(a);
      }
      const into = hit.size ? [...hit] : [answers.get(tiles[0].x + ":" + tiles[0].y)];
      for (const a of into) a.ways.push(w);
      home.set(w.id, into);
    }
    for (const name of GROUP_ORDER) for (const id of groups[name]) for (const a of home.get(id) || []) a.groups[name].push(id);
    return answers;
  };

  StreetIndex.MODE_CLASS = MODE_CLASS;
  global.StreetIndex = StreetIndex;
})(window);
