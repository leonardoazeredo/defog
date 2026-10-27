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
  // Unlisted profiles (hiking-mountain, shortest) use every way but motorways.
  const MODE_CLASS = { trekking: "bike", fastbike: "road", "car-fast": "car" };
  const SEG_M = 50;              // ways are chopped into ~50 m scoring segments
  const GRID_M = 250;            // spatial bin size for radius queries
  const MAX_SEGS = 400000;       // memory guard (~40 MB worst case)
  const CORRIDOR_M = 30;         // full width Fog of World clears as you travel
  const TILE_DEG = 0.025;        // fetch grid, ~2.8 x 1.75 km at 51°N: streets are fetched and remembered per tile; changing it means bumping the version in streetCache.js keys
  const TILE_EPS = 1e-9;         // in tiles: keeps a bound that sits on a tile edge from reaching into the neighbouring tile
  // a run sends no further request past this (the requests already open finish and keep all their
  // tiles), so a server that never recovers ends it with its progress; long, because every request
  // can spend a minute or more in the queue
  const RUN_DEADLINE_MS = 1200000;
  // waits before asking again after a busy answer (429, 502, 504); busy answers while a wait is set
  // are one step, and a busy answer after the third wait ends the run unless an answer landed with no
  // wait set since
  const BUSY_RETRY_MS = [15000, 30000, 60000];
  // the reasons a street source fails with (Overpass.post's, plus the run's own "superseded" stop); an
  // error with none of them is a bug, which is never worded or wrapped as a failed download. The
  // street cache keeps its own list (OUTAGE_REASONS): add a new Overpass reason to both.
  const STREET_REASONS = new Set(["busy", "blocked", "stalled", "offline", "server", "superseded"]);

  function StreetIndex(opts) {
    this.newFrac = opts.newFrac; // (lon,lat) -> 0..1 share of the corridor stamp still fogged
    // the street source: (tiles, kind, onTile, opts) -> Map "x:y" -> answer, calling onTile(tile, answer) as
    // each arrives (a source may return some tiles in the Map alone); opts is {cacheOnly: true} or {now, wait}
    this.fetchStreets = opts.fetchStreets || StreetIndex.overpassFetch;
    this.now = opts.now || Date.now; // the clock the run deadline is measured on
    this.sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.segs = new Map();       // "gx,gy" -> [{x,y,lon,lat,lenM,frac}]
    this.tiles = new Set();      // fetched coverage, StreetIndex.tileKey(kind, x, y)
    this.staleTiles = new Set(); // expired cached tiles a cache-only read drew from: not coverage, so a normal run fetches them again (their ways already held are kept as they were)
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
    this.version = 0;            // bumped by every tile read into the index, so graphs built from this notice list changes
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
  // withStale also counts the expired tiles already drawn from, so a cache-only read skips them.
  StreetIndex.prototype._uncovered = function (rects, kind, withStale) {
    const seen = new Set();
    const has = (set, t) => set.has(StreetIndex.tileKey(kind, t.x, t.y)) ||
      (kind !== "car" && set.has(StreetIndex.tileKey("run", t.x, t.y)));
    return rects.flatMap((r) => StreetIndex.tilesCovering(r)).filter((t) => {
      const k = t.x + ":" + t.y;
      if (seen.has(k)) return false;
      seen.add(k);
      return !(has(this.tiles, t) || (withStale && has(this.staleTiles, t)));
    });
  };

  StreetIndex.prototype._cover = function (tiles, kind) {
    for (const t of tiles) this.tiles.add(StreetIndex.tileKey(kind, t.x, t.y));
  };

  // Which way a routing profile may travel each way: 1 along its node order only, -1
  // against it, 0 both. One-ways bind the profiles on wheels, not walking or the
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

  // Fetch streets for the tiles under the given rects (skipping ones already covered), in one
  // call to the street source, nearest the centre of the rects first. kind: "run" | "bike" |
  // "car". Each tile is read into the index as it arrives, so a failed run keeps what came and
  // the next run asks only for the rest. opts.onProgress({done, total}) hears the start (done 0)
  // and every tile, and {done, total, waitUntil} when the source waits out a busy server (then
  // {done, total} again once the wait ends); opts.deadlineMs (default RUN_DEADLINE_MS) stops the run
  // before its next request once passed (every tile of a request already answered or still open is
  // read), and refuses a wait that would end past it. opts.stale() true (ignored for cacheOnly) means a
  // newer run replaced this one: it asks nothing further and rejects with cause reason
  // "superseded". Rejects, with StreetIndex.downloadError, whenever a tile is missing: suggestions
  // end in their error state rather than plan on part of the area. Anything else rejects as itself,
  // not wrapped in a download error (a bug reading a tile, in the caller's onProgress or in sleep
  // during a busy wait, or a source error with no street reason), so callers tell a bug from a
  // "streets-partial" shortfall (StreetIndex.isDownloadError); of several bugs the first is the
  // rejection. Resolves with {done, total, missing}.
  // opts.cacheOnly reads only what the street source already holds and resolves with the tiles
  // still missing (nearest first) instead of rejecting: what the Streets in fog look draws from.
  // A source that throws on such a read rejects as itself: no download ran, so it is a bug.
  StreetIndex.prototype.ensureRects = async function (rects, kind, opts) {
    opts = opts || {};
    const cacheOnly = !!opts.cacheOnly;
    const todo = this._uncovered(rects, kind, cacheOnly);
    if (!todo.length) return { done: 0, total: 0, missing: [] };
    this._anchor(rects[0].s);
    StreetIndex.nearestFirst(todo, rects);
    const deadlineMs = opts.deadlineMs == null ? RUN_DEADLINE_MS : opts.deadlineMs;
    const started = this.now();
    const read = new Set(), want = new Set(todo.map((t) => t.x + ":" + t.y));
    let broke = null; // the first bug thrown by code this run drives (reading a tile, onProgress, sleep): what the run rejects with
    const progress = (waitUntil) => {
      if (!opts.onProgress) return;
      opts.onProgress(waitUntil === undefined ? { done: read.size, total: todo.length } : { done: read.size, total: todo.length, waitUntil });
    };
    const stale = () => !cacheOnly && !!opts.stale && opts.stale();
    const superseded = () => Object.assign(new Error("streets: a newer run replaced this one"), { reason: "superseded" });
    // the source's wait before asking again: false when it would end past the deadline
    const wait = async (until) => {
      if (stale()) throw superseded();
      if (until - started > deadlineMs) return false;
      // requests still open when the busy came can outlast the wait: no busy text for a wait
      // already over
      if (until <= this.now()) return true;
      // the caller's onProgress and the sleep are not the run's own stop: a throw from them is a bug, but
      // the run's own superseded throw below is not
      try {
        progress(until);
        await this.sleep(Math.max(0, until - this.now()));
        if (stale()) throw superseded();
        progress();
      } catch (e) {
        if (!broke && !(e && e.reason === "superseded")) broke = e;
        throw e;
      }
      return true;
    };
    const take = (t, answer) => {
      const id = t.x + ":" + t.y;
      // a block's tile that came in its box unasked: read and covered unless already held, so a later
      // run need not ask for it, but not counted in this run's progress
      if (answer && !want.has(id) && !this.tiles.has(StreetIndex.tileKey(kind, t.x, t.y))) {
        this._read(answer);
        this._cover([t], kind);
      }
      if (!answer || !want.has(id) || read.has(id)) return;
      this._read(answer);
      this._cover([t], kind);
      read.add(id);
      progress();
    };
    progress();
    let answers;
    try {
      if (stale()) throw superseded();
      answers = await this.fetchStreets(todo, kind, (t, answer) => {
        try { take(t, answer); } catch (e) { if (!broke) broke = e; throw e; }
        if (cacheOnly || read.size === todo.length) return;
        if (stale()) throw superseded();
        if (this.now() - started >= deadlineMs) throw Object.assign(new Error("streets: run deadline passed"), { reason: "stalled" });
      }, cacheOnly ? { cacheOnly } : { now: this.now, wait });
    } catch (e) {
      if (broke) throw broke;
      if (cacheOnly) throw e;
      // only a download error or a failure with a street reason is a download failure; anything else is a bug in the source
      if (!StreetIndex.isDownloadError(e) && !STREET_REASONS.has(e && e.reason)) throw e;
      // a deadline raised on an earlier answer while the open requests landed the rest loses
      // nothing: the run is whole. A replaced run still rejects, so its caller does no more work.
      if (read.size < todo.length || e.reason === "superseded") throw StreetIndex.downloadError(read.size, todo.length, e);
    }
    if (cacheOnly) {
      // an answer in the Map alone is an expired copy: drawn from, but left uncovered so a
      // suggestion's run still asks for it
      for (const t of todo) {
        const id = t.x + ":" + t.y, answer = answers && answers.get(id);
        if (read.has(id) || !answer) continue;
        this._read(answer);
        this.staleTiles.add(StreetIndex.tileKey(kind, t.x, t.y));
        read.add(id);
        progress();
      }
      return { done: read.size, total: todo.length, missing: todo.filter((t) => !read.has(t.x + ":" + t.y)) };
    }
    // a source may hand tiles over in its Map alone
    for (const t of todo) take(t, answers && answers.get(t.x + ":" + t.y));
    const lost = todo.find((t) => !read.has(t.x + ":" + t.y));
    // the source answered but left a tile out: a server's fault, not the network's, worded generically
    if (lost) throw StreetIndex.downloadError(read.size, todo.length, Object.assign(new Error(`street source: no answer for tile ${lost.x}:${lost.y} (${kind})`), { reason: "server" }));
    return { done: read.size, total: todo.length, missing: [] };
  };

  // One tile's answer into the index; the version bump tells graphs built before it to rebuild.
  StreetIndex.prototype._read = function (answer) {
    for (const w of answer.ways) { this._addWay(w); this.classified.add(w.id); }
    for (const name of GROUP_ORDER) {
      const into = this.classIds[name] || this[name];
      for (const id of answer.groups[name] || []) into.add(id);
    }
    this.version++;
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

  // The fog moved (cells revealed or taken back): every segment is judged against it again, and the
  // version bump tells graphs built from the old fractions to rebuild.
  StreetIndex.prototype.invalidateFrac = function () {
    for (const cell of this.segs.values()) for (const s of cell) s.frac = null;
    this.version++;
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
  // text, with its [timeout:25] read as [timeout:60] (bench/lib/fetch-cache.js), so any edit
  // but a return to [timeout:60] makes every saved rectQuery answer miss. [timeout:25]
  // caps the server's run once the query leaves its queue. overpass-api.de sends nothing until the
  // run ends, so the client guard that binds is the 90 s first byte (FIRST_BYTE_MS in overpass.js):
  // a 39-68 s queue plus a 25 s run can still overrun it, and that request counts as a stall.
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
    let q = `[out:json][timeout:25];(${clauses(hw)})->.all;.all out skel geom;`;
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

  // A request asks for at most one 2x2 block of tiles (blocks start at even tile indices). On the
  // phone every request took about 5 s to its first byte from NextGIS (4.8-6.1 s, of which the
  // server ran a dense block in about 4.5 s) and waited 39-68 s in overpass-api.de's queue (#185),
  // whatever its size, so requests open at once (Overpass.cap()) share that wait where requests in a
  // row add it up; a block runs well inside [timeout:25], and a failure loses only its block. Splits
  // tiles (nearest first) by block, blocks in the order of their nearest tile.
  function batches(tiles) {
    const blocks = new Map();
    for (const t of tiles) {
      const b = Math.floor(t.x / 2) + ":" + Math.floor(t.y / 2);
      if (!blocks.has(b)) blocks.set(b, []);
      blocks.get(b).push(t);
    }
    return [...blocks.values()];
  }

  // The tiles a block's request brings: its missing tiles when they fill a rectangle (the block, a
  // strip of two, one tile), so nothing already held is asked again; else the whole block, since one
  // box over a ragged set covers the block anyway. The missing tiles come first, since a way that
  // lands in no tile goes to the first.
  function batchTiles(batch) {
    const xs = batch.map((t) => t.x), ys = batch.map((t) => t.y);
    if ((Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1) === batch.length) return batch;
    const x0 = Math.floor(xs[0] / 2) * 2, y0 = Math.floor(ys[0] / 2) * 2;
    const block = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => ({ x: x0 + dx, y: y0 + dy }));
    return batch.concat(block.filter((t) => !batch.some((b) => b.x === t.x && b.y === t.y)));
  }

  // The boxes a request's query asks for: one, the bounds of the tiles it brings (batchTiles).
  function batchBoxes(tiles) {
    const xs = tiles.map((t) => t.x), ys = tiles.map((t) => t.y);
    return [{ s: Math.min(...ys) * TILE_DEG, w: Math.min(...xs) * TILE_DEG, n: (Math.max(...ys) + 1) * TILE_DEG, e: (Math.max(...xs) + 1) * TILE_DEG }];
  }

  // The default street source: one Overpass request per 2x2 block (batches above), up to
  // Overpass.cap() of them open at once, each answer split per tile into onTile as it lands, including
  // the block's unasked tiles when a ragged set asks the whole block (they come in the box anyway, and
  // the street cache keeps them). A busy answer puts its block back in the queue and sets a wait of
  // BUSY_RETRY_MS (or its retryAt when later); busy answers while a wait is set are the same step.
  // Nothing new is sent until the wait ends, and the requests already open carry on. The wait goes
  // through opts.wait(until) -> false to give up (default: sleep until then on opts.now, default
  // Date.now) only once none is open, so the page shows the busy text only while nothing is coming.
  // An answer that lands while no wait is set starts the count again; one that lands beside a busy
  // answer, with a wait already set, does not. Any other failure carrying a street reason, a busy
  // answer after the last step, a refused wait, or a throw from onTile or opts.wait (the caller's stop,
  // or a bug), or any error with none of STREET_REASONS (a bug building a request or reading an
  // answer): nothing new is sent, the open requests finish and hand their tiles over, then the run
  // rejects with the failure that stopped it (for a refused wait, the last busy answer); the throws
  // that are not a download failure pass through unchanged. Holds nothing, so a cache-only read
  // (opts.cacheOnly) gets no tile from it.
  StreetIndex.overpassFetch = function (tiles, kind, onTile, opts) {
    opts = opts || {};
    const out = new Map();
    if (opts.cacheOnly) return Promise.resolve(out);
    const now = opts.now || Date.now;
    const wait = opts.wait || ((until) => new Promise((resolve) => setTimeout(() => resolve(true), Math.max(0, until - now()))));
    const queue = batches(tiles).map((batch, rank) => ({ batch, rank }));
    const got = () => tiles.filter((t) => out.has(t.x + ":" + t.y)).length;
    return new Promise((resolve, reject) => {
      let open = 0, busy = 0, until = 0, lastBusy = null, waiting = false, stop = null;
      // an error without a street reason is a bug and passes through unchanged, like the caller's own throws
      const fail = (e, passThrough) => { if (!stop) stop = { e, passThrough: passThrough || !STREET_REASONS.has(e && e.reason) }; };
      const pump = () => {
        if (stop) {
          if (!open) reject(stop.passThrough ? stop.e : StreetIndex.downloadError(got(), tiles.length, stop.e));
          return;
        }
        if (until) {
          if (open || waiting) return;
          waiting = true;
          Promise.resolve(until).then(wait).then((go) => {
            waiting = false; until = 0;
            if (!go) fail(lastBusy, false);
            pump();
          }, (e) => { waiting = false; until = 0; fail(e, true); pump(); });
          return;
        }
        // a throw here (building a request, reading the cap) is a bug and may come from an answer's
        // handler, where nothing would catch it and the run would never settle
        try {
          while (!stop && queue.length && open < global.Overpass.cap()) send(queue.shift());
        } catch (e) { fail(e, true); }
        if (stop) return pump();
        if (!open) resolve(out);
      };
      const send = (item) => {
        const ask = batchTiles(item.batch);
        // built before open++: a throw after it would leave a request open that no answer ever closes
        const body = "data=" + encodeURIComponent(StreetIndex.rectQuery(batchBoxes(ask), kind));
        open++;
        global.Overpass.post(body).then((json) => {
          open--;
          // only an answer sent after the last wait proves the server recovered; one already open
          // when the busy came does not
          if (!until) busy = 0;
          let answers;
          try { answers = StreetIndex.splitAnswer(json, ask); } catch (e) { fail(e, false); return pump(); }
          // the whole answer is in: every tile of it is handed over, whatever the caller throws
          for (const t of ask) {
            const answer = answers.get(t.x + ":" + t.y);
            out.set(t.x + ":" + t.y, answer);
            try { if (onTile) onTile(t, answer); } catch (e) { fail(e, true); }
          }
          pump();
        }, (e) => {
          open--;
          if (e.reason !== "busy") fail(e, false);
          else if (!stop) {
            lastBusy = e;
            queue.push(item);
            queue.sort((a, b) => a.rank - b.rank);
            if (until) until = Math.max(until, e.retryAt || 0);
            else if (busy === BUSY_RETRY_MS.length) fail(e, false);
            else until = Math.max(now() + BUSY_RETRY_MS[busy++], e.retryAt || 0);
          }
          pump();
        });
      };
      pump();
    });
  };

  // The error a street source or ensureRects rejects with when a tile is missing: how many of the
  // tiles asked for arrived (done of total), the failure that stopped the run as `cause`, its
  // retryAt, and reason "streets-partial" once any tile arrived (else the cause's own reason).
  // A cause that is itself such an error is unwrapped, so `cause` is always the first failure.
  StreetIndex.downloadError = function (done, total, cause) {
    const first = cause && typeof cause.total === "number" && cause.cause ? cause.cause : cause;
    const err = new Error(`streets: got ${done} of ${total} tiles` + (first && first.message ? ": " + first.message : ""));
    err.done = done; err.total = total; err.cause = first;
    err.reason = done > 0 ? "streets-partial" : first && first.reason;
    if (first && first.retryAt) err.retryAt = first.retryAt;
    return err;
  };

  // Whether a street download fell short (a downloadError), rather than a bug ensureRects rethrows
  // as itself: only the first is worded as a download failure.
  StreetIndex.isDownloadError = function (e) {
    return !!e && typeof e.total === "number" && typeof e.done === "number";
  };

  // Whether a run ended because a newer one replaced it (opts.stale): nothing went wrong, so a caller
  // neither shows nor logs it. A bug thrown while a run is stale is still logged by its class; a
  // download failure while stale is simply not shown.
  StreetIndex.isSuperseded = function (e) {
    return StreetIndex.isDownloadError(e) && !!e.cause && e.cause.reason === "superseded";
  };

  // What a caller may pass on from a failed download, for StreetMessages to word: the reasons, counts and
  // retry time, never the message, which can hold a server remark or a tile number.
  StreetIndex.downloadFacts = function (e) {
    return {
      reason: e && e.reason, done: e && e.done, total: e && e.total, retryAt: e && e.retryAt,
      cause: e && e.cause ? { reason: e.cause.reason } : undefined,
    };
  };

  // Sorts tiles in place by distance from the centre of the rects' bounding box, longitude scaled to
  // ground distance at that latitude; equal distances keep their order.
  StreetIndex.nearestFirst = function (tiles, rects) {
    const s = Math.min(...rects.map((r) => r.s)), n = Math.max(...rects.map((r) => r.n));
    const w = Math.min(...rects.map((r) => r.w)), e = Math.max(...rects.map((r) => r.e));
    const lat = (s + n) / 2, lng = (w + e) / 2, kx = Math.cos(lat * Math.PI / 180);
    const d = (t) => Math.hypot(((t.x + 0.5) * TILE_DEG - lng) * kx, (t.y + 0.5) * TILE_DEG - lat);
    tiles.sort((a, b) => d(a) - d(b));
  };

  // Reads an Overpass answer to a rectQuery and hands each requested tile its share.
  StreetIndex.splitAnswer = function (gj, tiles) {
    // a timeout or out-of-memory still answers 200, with whatever it had by then
    if (gj.remark) throw Object.assign(new Error("overpass: " + gj.remark), { reason: "server" });
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
