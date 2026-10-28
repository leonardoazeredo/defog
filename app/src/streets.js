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
  // Past EVICT_AT of the cap a read first drops the least recently used pieces, down to EVICT_TO (see
  // _makeRoom): the 15% left above EVICT_AT is room for the pieces one read brings before the cap cuts
  // a way short, and dropping to EVICT_TO frees room for several reads, not one drop per read
  const EVICT_AT = 0.85, EVICT_TO = 0.7;
  const CORRIDOR_M = 30;         // full width Fog of World clears as you travel
  const TILE_DEG = 0.025;        // fetch grid, ~2.8 x 1.75 km at 51°N: streets are fetched and remembered per tile; changing it means bumping the version in streetCache.js keys
  const TILE_EPS = 1e-9;         // in tiles: keeps a bound that sits on a tile edge from reaching into the neighbouring tile
  // a run sends no further request past this (the requests already open finish and keep all their
  // tiles), so a server that never recovers ends it with its progress; long, because every request
  // can spend a minute or more in the queue
  const RUN_DEADLINE_MS = 1200000;
  // waits before asking again after a busy answer (429, 502, 504); busy answers while a wait is set
  // are one step, and a busy answer after the third wait ends the run unless an answer lands while
  // the requests open with it are still running, so it ends the same whichever of them lands first
  const BUSY_RETRY_MS = [15000, 30000, 60000];
  // the reasons a street source fails with (Overpass.post's, "superseded" among them, which the run's
  // own stop also uses); an error with none of them is a bug, which is never worded or wrapped as a
  // failed download. The street cache keeps its own list of outages (OUTAGE_REASONS, without
  // superseded): add a new Overpass outage reason to both.
  const STREET_REASONS = new Set(["busy", "blocked", "stalled", "offline", "server", "superseded"]);

  function StreetIndex(opts) {
    this.newFrac = opts.newFrac; // (lon,lat) -> 0..1 share of the corridor stamp still fogged
    // the street source: (tiles, kind, onTile, opts) -> Map "x:y" -> answer, calling onTile(tile, answer) as
    // each arrives (a source may return some tiles in the Map alone); opts is {cacheOnly: true} or {now, wait, stale}
    this.fetchStreets = opts.fetchStreets || StreetIndex.overpassFetch;
    this.now = opts.now || Date.now; // the clock the run deadline is measured on
    this.sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.segs = new Map();       // "gx,gy" -> [{x,y,lon,lat,lenM,frac}]
    this.tiles = new Set();      // fetched coverage, StreetIndex.tileKey(kind, x, y)
    this.staleTiles = new Set(); // expired cached tiles a cache-only read drew from: not coverage, so a normal run fetches them again
    // ways held only because an expired copy brought them: id -> {from: the staleTiles keys of the expired copies that still list it,
    // segs: its scoring segments}. A fresh answer replaces them (see _read); a way any fresh tile brought is not here.
    this.staleWays = new Map();
    this.onWaysChanged = null;   // called once a read has dropped or replaced ways, for a reader that drew them (the Streets in fog look)
    this.wayEpoch = 0;           // bumped when a way leaves the index or is replaced, so a reader that went through `ways` once starts over
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
    this.maxSegs = opts.maxSegs || MAX_SEGS;
    // what a piece's eviction needs: id -> {from: the tile keys whose answer lists the way, segs: its scoring
    // segments} for every way held (staleWays shares these entries), and "x:y" -> the ids of the ways a read
    // of that piece listed (it can still name ways dropped since)
    this.wayFrom = new Map();
    this.pieceWays = new Map();
    this.used = new Map();       // "x:y" of every piece read or under a run's rects, least recently used first
    this.runs = new Set();       // the "x:y" under the rects of each ensureRects still running: never evicted
    this.holds = new Map();      // opts.holdAs -> the "x:y" under that caller's latest run: never evicted until its next one
    this.version = 0;            // bumped by every tile read into the index, so graphs built from this notice list changes
    this.inFlight = new Map();   // StreetIndex.tileKey -> {key, promise, done}: a tile a running ensureRects is asking for, which a later run waits for
    this.kx = null; this.ky = 110540; // metre frame, anchored on first fetch
  }

  const holds = (set, kind, t) => set.has(StreetIndex.tileKey(kind, t.x, t.y)) ||
    (kind !== "car" && set.has(StreetIndex.tileKey("run", t.x, t.y)));
  const cellKey = (x, y) => Math.floor(x / GRID_M) + "," + Math.floor(y / GRID_M);

  StreetIndex.prototype._anchor = function (lat) {
    if (this.kx === null) this.kx = 111320 * Math.cos(lat * Math.PI / 180);
  };

  StreetIndex.prototype.covered = function (lat, lng) {
    const t = StreetIndex.tileOf(lng, lat);
    return ["run", "bike", "car"].some((k) => this.tiles.has(StreetIndex.tileKey(k, t.x, t.y)));
  };

  // entry, when given, is the way's wayFrom entry made beforehand (one an expired copy brought is in
  // staleWays before its segments are added)
  StreetIndex.prototype._addWay = function (w, entry) {
    if (!w.geometry || w.geometry.length < 2 || this.wayIds.has(w.id)) return;
    this.wayIds.add(w.id);
    entry = entry || { from: new Set(), segs: [] };
    this.wayFrom.set(w.id, entry);
    if (w.nodes && w.nodes.length === w.geometry.length) this.ways.push({ id: w.id, nodes: w.nodes, geometry: w.geometry });
    for (let i = 1; i < w.geometry.length && this.segCount < this.maxSegs; i++) {
      const a = w.geometry[i - 1], b = w.geometry[i];
      const ax = a.lon * this.kx, ay = a.lat * this.ky;
      const bx = b.lon * this.kx, by = b.lat * this.ky;
      const edgeM = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(edgeM / SEG_M));
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        const key = cellKey(x, y);
        let cell = this.segs.get(key);
        if (!cell) this.segs.set(key, (cell = []));
        const seg = { x, y, lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t, lenM: edgeM / n, frac: null };
        cell.push(seg);
        entry.segs.push(seg);
        this.segCount++;
      }
    }
  };

  // Takes ways out of the index: ones an expired copy brought, or ones no piece lists after an eviction.
  // The MAX_SEGS share must be given back and every list the way joined must forget it, or a replaced
  // way would count twice.
  StreetIndex.prototype._dropWays = function (ids) {
    if (!ids.length) return;
    const gone = new Set(ids), dead = new Map();
    for (const id of ids) {
      for (const seg of this.wayFrom.get(id).segs) {
        const key = cellKey(seg.x, seg.y);
        if (!dead.has(key)) dead.set(key, new Set());
        dead.get(key).add(seg);
      }
      this.wayFrom.delete(id);
      this.staleWays.delete(id);
      this.wayIds.delete(id);
      this.classified.delete(id);
      for (const name of GROUP_ORDER) (this.classIds[name] || this[name]).delete(id);
    }
    for (const [key, segs] of dead) {
      const live = this.segs.get(key).filter((seg) => !segs.has(seg));
      if (live.length) this.segs.set(key, live); else this.segs.delete(key);
      this.segCount -= segs.size;
    }
    this.ways = this.ways.filter((w) => !gone.has(w.id));
    this.wayEpoch++;
  };

  StreetIndex.prototype._use = function (pos) {
    this.used.delete(pos);
    this.used.set(pos, true);
  };

  // Near the cap, drops the least recently used pieces that no running or held run covers: every kind of
  // the piece stops counting as held (a run asks for it again, a cache-only read reads it again), and a
  // way goes once no held piece lists it, fresh or expired; one left listed by expired copies alone is
  // in staleWays again, so a fresh answer can replace it.
  StreetIndex.prototype._makeRoom = function () {
    if (this.segCount <= this.maxSegs * EVICT_AT) return;
    const kept = [...this.runs, ...this.holds.values()];
    const evicted = [], gone = [];
    let left = this.segCount;
    for (const pos of this.used.keys()) {
      if (left <= this.maxSegs * EVICT_TO) break;
      if (kept.some((under) => under.has(pos))) continue;
      evicted.push(pos);
      const keys = ["run", "bike", "car"].map((k) => k + ":" + pos);
      for (const k of keys) { this.tiles.delete(k); this.staleTiles.delete(k); }
      for (const id of this.pieceWays.get(pos) || []) {
        const entry = this.wayFrom.get(id);
        // every kind of the piece removed, not just the first that matches
        if (!entry || !keys.map((k) => entry.from.delete(k)).some(Boolean)) continue;
        if (!entry.from.size) { gone.push(id); left -= entry.segs.length; }
        else if (!this.staleWays.has(id) && ![...entry.from].some((k) => this.tiles.has(k))) this.staleWays.set(id, entry);
      }
      this.pieceWays.delete(pos);
    }
    if (!evicted.length) return;
    for (const pos of evicted) this.used.delete(pos);
    this._dropWays(gone);
    // pieces went, though no way did: the Streets in fog badge must still count them missing
    if (!gone.length) this.wayEpoch++;
  };

  // A tile counts as covered when it was fetched for the same kind AND fetched at
  // least the streets asked for now: the walking set is a superset of the bike
  // set, so a "run" fetch satisfies a later "bike" request but not vice versa. A car
  // fetch holds motorways, which nothing else does, so only a car fetch covers cars.
  // withStale also counts the expired tiles already drawn from, so a cache-only read skips them.
  StreetIndex.prototype._uncovered = function (rects, kind, withStale) {
    return StreetIndex.tilesOf(rects).filter((t) => !(holds(this.tiles, kind, t) || (withStale && holds(this.staleTiles, kind, t))));
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

  // Fetch streets for the tiles under the given rects (skipping ones already covered), nearest the
  // centre of the rects first, in one call to the street source. A tile an earlier run is still asking
  // for is waited for instead, and asked for in a second call only if that run gives it up.
  // kind: "run" | "bike" | "car". Each tile is read into the index as it arrives, so a failed run keeps what came and
  // the next run asks only for the rest. opts.onProgress({done, total}) hears the start (done = the
  // tiles already held, total = every tile under the rects; nothing when all are held) and every
  // tile, and {done, total, waitUntil} when the source waits out a busy server (then {done, total}
  // again once the wait ends); opts.deadlineMs (default RUN_DEADLINE_MS) stops the run
  // before its next request once passed (every tile of a request already answered or still open is
  // read), and refuses a wait that would end past it. opts.stale() true (ignored for cacheOnly) means a
  // newer run replaced this one: it asks nothing further and rejects with cause reason
  // "superseded". Rejects, with StreetIndex.downloadError, whenever a tile is missing: suggestions
  // end in their error state rather than plan on part of the area. Anything else rejects as itself,
  // not wrapped in a download error (a bug reading a tile, in the caller's onProgress or in sleep
  // during a busy wait, or a source error with no street reason), so callers tell a bug from a
  // "streets-partial" shortfall (StreetIndex.isDownloadError); of several bugs the first is the
  // rejection, unless, outside a cache-only read, the source rejects with a bug of its own (see fetchSome's catch
  // below). Resolves with {done, total, missing}.
  // opts.cacheOnly reads only what the street source already holds and resolves with the tiles
  // still missing (nearest first) instead of rejecting: what the Streets in fog look draws from.
  // A source that throws on such a read rejects as itself: no download ran, so it is a bug.
  // Every piece under the rects counts as used, and none of them is evicted while the run (cache-only
  // included) is running; opts.holdAs (a caller's name) keeps them until that caller's next run, for a
  // caller that plans on them once the run is over.
  StreetIndex.prototype.ensureRects = function (rects, kind, opts) {
    let under;
    // a bad rect rejects rather than throwing at the call, so a .then caller hears of it
    try { under = new Set(StreetIndex.tilesOf(rects).map((t) => t.x + ":" + t.y)); } catch (e) { return Promise.reject(e); }
    for (const pos of under) this._use(pos);
    if (opts && opts.holdAs) this.holds.set(opts.holdAs, under);
    this.runs.add(under);
    const run = this._ensureRects(rects, kind, opts);
    // the caller's promise is the run itself, so this adds no step before the caller resumes
    const end = () => { this.runs.delete(under); };
    run.then(end, end);
    return run;
  };

  StreetIndex.prototype._ensureRects = async function (rects, kind, opts) {
    opts = opts || {};
    const cacheOnly = !!opts.cacheOnly;
    const todo = this._uncovered(rects, kind, cacheOnly);
    // total is every tile under the rects and the tiles already held count as done from the first
    // report, so a retry shows the same N as the run before it. In a normal run an expired copy is
    // not held: it is asked for again and counted once it is read.
    const total = StreetIndex.tilesOf(rects).length, held = total - todo.length;
    if (!todo.length) return { done: total, total, missing: [] };
    this._anchor(rects[0].s);
    StreetIndex.nearestFirst(todo, rects);
    const deadlineMs = opts.deadlineMs == null ? RUN_DEADLINE_MS : opts.deadlineMs;
    const started = this.now();
    const tid = (t) => t.x + ":" + t.y;
    const read = new Set(), want = new Set(todo.map(tid));
    // tiles read here that were not a fresh street-cache answer (onTile's {cached: true}): what
    // downloadError takes as `arrived`
    let downloaded = 0;
    let broke = null; // the first bug thrown by code this run drives (reading a tile, onProgress, sleep): what the run rejects with, unless the source has a bug of its own (see fetchSome's catch)
    const progress = (waitUntil) => {
      if (!opts.onProgress) return;
      opts.onProgress(waitUntil === undefined ? { done: held + read.size, total } : { done: held + read.size, total, waitUntil });
    };
    const stale = () => !cacheOnly && !!opts.stale && opts.stale();
    const superseded = () => Object.assign(new Error("streets: a newer run replaced this one"), { reason: "superseded" });
    const deadlinePassed = () => Object.assign(new Error("streets: run deadline passed"), { reason: "stalled" });
    const short = (cause) => StreetIndex.downloadError(held + read.size, total, cause, downloaded);
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
    // A tile a normal run asks for is in flight from then until it is read or the run's call to the
    // source ends, and a later run that needs it waits for it instead of asking again. A run
    // waits only for runs that started before it, so two runs never wait on each other.
    const claims = new Map(); // "x:y" -> this run's in-flight entry for it
    const claim = (tiles) => {
      for (const t of tiles) {
        const entry = { key: StreetIndex.tileKey(kind, t.x, t.y) };
        entry.promise = new Promise((resolve) => { entry.done = resolve; });
        claims.set(tid(t), entry);
        this.inFlight.set(entry.key, entry);
      }
    };
    // via: what the source said of the tile it read ({cached: true} from the street cache), or
    // nothing when the run gave the tile up
    const unclaim = (id, via) => {
      const entry = claims.get(id);
      if (!entry) return;
      claims.delete(id);
      if (this.inFlight.get(entry.key) === entry) this.inFlight.delete(entry.key);
      entry.done(via);
    };
    const take = (t, answer, via) => {
      const id = tid(t);
      // a street block's tile that came in its box unasked: read and covered unless already held, so a later
      // run need not ask for it, but not counted in this run's progress
      if (answer && !want.has(id) && !this.tiles.has(StreetIndex.tileKey(kind, t.x, t.y))) {
        this._read(answer, { kind, x: t.x, y: t.y });
        this._cover([t], kind);
      }
      if (!answer || !want.has(id) || read.has(id)) return;
      this._read(answer, { kind, x: t.x, y: t.y });
      this._cover([t], kind);
      read.add(id);
      if (!(via && via.cached)) downloaded++;
      unclaim(id, via || {});
      progress();
    };
    const ownStops = new Set(); // the deadline errors this run threw from onTile, which a source hands back as its failure
    const onTile = (t, answer, via) => {
      try { take(t, answer, via); } catch (e) { if (!broke) broke = e; throw e; }
      if (cacheOnly || read.size === todo.length) return;
      if (stale()) throw superseded();
      if (this.now() - started >= deadlineMs) { const e = deadlinePassed(); ownStops.add(e); throw e; }
    };
    // One call to the street source; its tiles are in flight for this run until it ends.
    const fetchSome = async (tiles) => {
      if (!cacheOnly) claim(tiles);
      try {
        let answers;
        try {
          if (stale()) throw superseded();
          answers = await this.fetchStreets(tiles, kind, onTile, cacheOnly ? { cacheOnly } : { now: this.now, wait, stale });
        } catch (e) {
          // a source's own bug is thrown ahead of the run's (see the docstring); `broke` covers a run
          // bug the source rejects as a download error
          if (!cacheOnly && !StreetIndex.isDownloadError(e) && !STREET_REASONS.has(e && e.reason)) throw e;
          if (broke) throw broke;
          if (cacheOnly) throw e;
          // a deadline raised on an earlier answer while the open requests landed the rest loses
          // nothing: the call is whole. A replaced run still rejects, so its caller does no more work.
          if (tiles.some((t) => !read.has(tid(t))) || (e && e.reason === "superseded")) throw short(e);
          // nothing this call asked for is missing, so its failure is not the run's to show, but a source that
          // fails after handing every tile is worth seeing; not for a replaced run (never logged). The class
          // and the street reason (download errors are all Error) only, as a message can name a tile
          if (!ownStops.has(e) && !stale()) console.warn("[streets] a street source failed after every piece it was asked for arrived", e && e.name, e && e.reason);
        }
        // a source that swallowed the caller's throw and resolved anyway still hands the bug on
        if (broke) throw broke;
        // a source may hand tiles over in its Map alone
        if (!cacheOnly) for (const t of tiles) take(t, answers && answers.get(tid(t)));
        return answers;
      } finally {
        for (const t of tiles) unclaim(tid(t));
      }
    };

    // the tiles another run is already bringing (a run tile stands in for bike, as in _uncovered); the
    // rest this run asks for itself. A cache-only read waits for nothing and claims nothing.
    const split = (tiles) => {
      const shared = [], ask = [];
      for (const t of tiles) {
        const entry = !cacheOnly && (this.inFlight.get(StreetIndex.tileKey(kind, t.x, t.y)) ||
          (kind !== "car" && this.inFlight.get(StreetIndex.tileKey("run", t.x, t.y))));
        if (entry) shared.push({ t, entry }); else ask.push(t);
      }
      return { shared, ask };
    };
    let settled = false;
    // Settles once every shared tile is read or given up by the run bringing it. Rejects superseded
    // at the first one that lands after this run went stale, leaving the other run's request alone: a
    // run that waits only on shared tiles has no other moment to notice it was replaced.
    const waitFor = (shared) => new Promise((resolve, reject) => {
      let left = shared.length;
      for (const { t, entry } of shared) entry.promise.then((via) => {
        if (settled) return;
        const id = tid(t);
        // a throw here (onProgress, the caller's stale) is a bug: the wait rejects with it rather than never settling
        try {
          // covered: the other run read it; else it gave the tile up, and this run asks for it again
          if (!read.has(id) && holds(this.tiles, kind, t)) {
            read.add(id);
            if (via && !via.cached) downloaded++;
            progress();
          }
          if (stale()) reject(short(superseded()));
          else if (!--left) resolve();
        } catch (e) {
          if (!broke) broke = e;
          reject(e);
        }
      });
    });
    progress();
    let answers;
    try {
      let { shared, ask } = split(todo);
      for (let pass = 0; ; pass++) {
        // started before this run's own call, which can outlast every shared tile
        const sharedIn = shared.length ? waitFor(shared) : null;
        if (sharedIn) sharedIn.catch(() => {}); // awaited only after this run's own call, so a rejection before then is not reported as unhandled
        if (ask.length) {
          const got = await fetchSome(ask);
          if (!pass) answers = got;
        }
        if (!sharedIn) break;
        // a bug beside the wait's superseded rejection is still the run's rejection
        try { await sharedIn; } catch (e) { throw broke || e; }
        if (broke) throw broke;
        // what the other run gave up on (it failed, or was replaced, before reading it); split again,
        // so of several runs waiting for it one asks and the rest wait for that one
        const left = shared.map((x) => x.t).filter((t) => !read.has(tid(t)));
        if (!left.length) break;
        if (stale()) throw short(superseded());
        if (this.now() - started >= deadlineMs) throw short(deadlinePassed());
        // a run that waited beside this one may have asked and read it already; not counted as
        // downloaded, as this run cannot tell whether the street cache answered that run
        for (const t of left) if (holds(this.tiles, kind, t)) { read.add(tid(t)); progress(); }
        ({ shared, ask } = split(left.filter((t) => !read.has(tid(t)))));
        if (!shared.length && !ask.length) break;
      }
    } finally {
      settled = true;
    }
    if (broke) throw broke;
    // replaced while its last request was open (onTile stops checking once every tile is read): it
    // still rejects, so its caller does no more work
    if (stale()) throw short(superseded());
    if (cacheOnly) {
      // an answer in the Map alone is an expired copy: drawn from, but left uncovered so a
      // suggestion's run still asks for it; that run's fresh answer then replaces the ways read here
      for (const t of todo) {
        const id = tid(t), answer = answers && answers.get(id);
        if (read.has(id) || !answer) continue;
        // a run that covered the tile while this read was open already holds fresher ways: an expired
        // copy added now would leave ways the fresh answer lacks, and nothing would ask for the tile again
        if (holds(this.tiles, kind, t)) { read.add(id); progress(); continue; }
        this._read(answer, { kind, x: t.x, y: t.y, stale: true });
        this.staleTiles.add(StreetIndex.tileKey(kind, t.x, t.y));
        read.add(id);
        progress();
      }
      return { done: held + read.size, total, missing: todo.filter((t) => !read.has(tid(t))) };
    }
    const lost = todo.find((t) => !read.has(tid(t)));
    // the source answered but left a tile out: a server's fault, not the network's, worded generically
    if (lost) throw short(Object.assign(new Error(`street source: no answer for tile ${lost.x}:${lost.y} (${kind})`), { reason: "server" }));
    return { done: total, total, missing: [] };
  };

  // One tile's answer into the index; the version bump tells graphs built before it to rebuild.
  // from is the tile ({kind, x, y}, plus stale: true for an expired copy). A way is held while any
  // tile brings it, and splitAnswer hands a whole way to every tile it touches (the first, when none
  // holds one of its points), so:
  //  - a fresh answer replaces every expired copy of a way it lists, whichever tile brought that copy;
  //  - a way held only through expired copies goes when the fresh answer lacks it and no other copy
  //    still lists it (the other expired tiles are refreshed in their turn);
  //  - an expired copy adds no way a fresh tile holds, and no class or one-way flag to one, so it
  //    never overwrites fresher data;
  //  - a fresh answer of kind K replaces what an expired copy of K (and, for run, of bike) brought:
  //    a bike answer never lists a footway, so it cannot say one is gone.
  StreetIndex.prototype._read = function (answer, from) {
    const epoch = this.wayEpoch, stale = !!(from && from.stale), key = from && StreetIndex.tileKey(from.kind, from.x, from.y);
    const pos = from && from.x + ":" + from.y;
    // _dropWays below discards each replaced way's entry, so the expired copies that still list it are
    // carried into the rebuilt one: an eviction of this piece then leaves the way to them
    const carry = new Map();
    if (from && !stale) {
      const mine = (from.kind === "run" ? ["run", "bike"] : [from.kind]).map((k) => StreetIndex.tileKey(k, from.x, from.y));
      const listed = new Set(answer.ways.map((w) => w.id)), out = new Set();
      for (const id of listed) {
        const held = this.staleWays.get(id);
        if (held) { out.add(id); carry.set(id, held.from); }
      }
      // a way an earlier read of this piece listed and this answer lacks is no longer listed by this
      // piece's kinds; a kind already held fresh keeps its ways (a bike answer lists foot=no ways a run answer lacks)
      for (const id of this.pieceWays.get(pos) || []) {
        const entry = this.wayFrom.get(id);
        if (!entry || listed.has(id)) continue;
        for (const k of mine) if (!this.tiles.has(k)) entry.from.delete(k);
        if (!entry.from.size) out.add(id);
      }
      this._dropWays([...out]);
    }
    const freshHeld = new Set();
    try {
      if (from) { this._use(pos); this._makeRoom(); }
      this._addAnswer(answer, stale, key, freshHeld);
      for (const [id, keys] of carry) {
        const entry = this.wayFrom.get(id);
        // a copy this read's _makeRoom evicted has had its keys cleared, and nothing would clear one added now
        if (entry) for (const k of keys) if (this.tiles.has(k) || this.staleTiles.has(k)) entry.from.add(k);
      }
    } finally {
      // a throw midway leaves ways dropped: the graphs built before must still rebuild
      this.version++;
      if (this.wayEpoch !== epoch && this.onWaysChanged) Promise.resolve().then(() => this.onWaysChanged());
    }
  };

  // the per-way part of _read; freshHeld collects what an expired copy must not add classes to
  StreetIndex.prototype._addAnswer = function (answer, stale, key, freshHeld) {
    const pos = key && key.slice(key.indexOf(":") + 1); // the piece's "x:y"
    for (const w of answer.ways) {
      const held = this.staleWays.get(w.id);
      if (held) { if (stale) held.from.add(key); } // a fresh read with a tile has dropped its listed ways above
      else if (stale && !this.wayIds.has(w.id)) {
        // registered before the add so a way that throws midway can still be taken out
        const entry = { from: new Set([key]), segs: [] };
        this.staleWays.set(w.id, entry);
        this._addWay(w, entry);
        if (!this.wayIds.has(w.id)) this.staleWays.delete(w.id);
      } else {
        if (stale && this.wayIds.has(w.id)) freshHeld.add(w.id);
        this._addWay(w);
      }
      // every piece whose answer lists the way holds it, so an eviction keeps a way another piece still lists
      if (pos && this.wayIds.has(w.id)) {
        this.wayFrom.get(w.id).from.add(key);
        if (!this.pieceWays.has(pos)) this.pieceWays.set(pos, new Set());
        this.pieceWays.get(pos).add(w.id);
      }
      this.classified.add(w.id);
    }
    for (const name of GROUP_ORDER) {
      const into = this.classIds[name] || this[name];
      for (const id of answer.groups[name] || []) if (!freshHeld.has(id)) into.add(id);
    }
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
  // Every tile under the rects, each once.
  StreetIndex.tilesOf = (rects) => {
    const seen = new Set();
    return rects.flatMap((r) => StreetIndex.tilesCovering(r)).filter((t) => {
      const k = t.x + ":" + t.y;
      return !seen.has(k) && seen.add(k);
    });
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

  // A request asks for at most one street block, a 2x2 group of tiles starting at even tile indices
  // (not Fog of World's bitmap block). On the phone every request took about 5 s to its first byte
  // from NextGIS (4.8-6.1 s, of which the server ran a dense street block in about 4.5 s) and waited
  // 39-68 s in overpass-api.de's queue (#185), whatever its size, so requests open at once
  // (Overpass.cap()) share that wait where requests in a row add it up; a street block runs well inside
  // [timeout:25], and a failure loses only its street block. Splits tiles (nearest first) by street
  // block, street blocks in the order of their nearest tile.
  function batches(tiles) {
    const blocks = new Map();
    for (const t of tiles) {
      const b = Math.floor(t.x / 2) + ":" + Math.floor(t.y / 2);
      if (!blocks.has(b)) blocks.set(b, []);
      blocks.get(b).push(t);
    }
    return [...blocks.values()];
  }

  // The tiles a street block's request brings: its missing tiles when they fill a rectangle (the street
  // block, a strip of two, one tile), so nothing already held is asked again; else the whole street
  // block, since one box over a ragged set covers it anyway. The missing tiles come first, since a way that
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

  // The default street source: one Overpass request per street block (batches above), up to
  // Overpass.cap() of them open at once, each answer split per tile into onTile as it lands, including
  // the street block's unasked tiles when a ragged set asks the whole street block (they come in the
  // box anyway, and the street cache keeps them). A busy answer puts its street block back in the queue
  // and sets a wait of BUSY_RETRY_MS (or its retryAt when later); busy answers while a wait is set are
  // the same step. Nothing new is sent until the wait ends, and the requests already open carry on. The
  // wait goes through opts.wait(until) -> false to give up (default: sleep until then on opts.now,
  // default Date.now) only once none is open, so the page shows the busy text only while nothing is
  // coming. An answer that lands while no wait is set starts the count again; one that lands beside a
  // busy answer, with a wait already set, does not. A busy answer after the last step ends the run only
  // once the requests open with it have finished and none was answered; if one was, the server has
  // recovered and that busy is the first step of a new count, so the outcome does not depend on which
  // answer lands first. opts.stale goes to Overpass.post, so a replaced run's posts still waiting for
  // a slot are not sent (they fail "superseded"). Any other failure carrying a street reason, a busy
  // answer ending the count, a refused wait, or a throw from onTile or opts.wait (the caller's stop, or
  // a bug), or any error with none of STREET_REASONS (a bug building a request or reading an answer):
  // nothing new is sent, the open requests finish and hand their tiles over, then the run rejects with
  // the failure that stopped it (for a refused wait or an ended count, the last busy answer); the throws
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
      // last: the wait set is the step past the schedule, ending the run unless recovered (a request
      // was answered while it was set) by the time the requests open with it have finished
      let open = 0, busy = 0, until = 0, lastBusy = null, waiting = false, stop = null, last = false, recovered = false;
      // an error without a street reason is a bug and passes through unchanged, like the caller's own throws
      const fail = (e, passThrough) => { if (!stop) stop = { e, passThrough: passThrough || !STREET_REASONS.has(e && e.reason) }; };
      const pump = () => {
        if (stop) {
          if (!open) reject(stop.passThrough ? stop.e : StreetIndex.downloadError(got(), tiles.length, stop.e));
          return;
        }
        if (until) {
          if (open || waiting) return;
          if (last) {
            last = false;
            if (!recovered) { fail(lastBusy, false); return pump(); }
            busy = 1;
          }
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
        // the query is built and the request started before open++, so a throw from either never
        // leaves a counted request that no answer closes
        const request = global.Overpass.post("data=" + encodeURIComponent(StreetIndex.rectQuery(batchBoxes(ask), kind)), { stale: opts.stale });
        open++;
        // a throw from a handler (a bug) must still end the run: nothing else catches it
        const guard = (handler) => (v) => { try { handler(v); } catch (e) { fail(e, true); pump(); } };
        request.then(guard((json) => {
          open--;
          // an answer with no wait set restarts the count; one that lands while the final wait is set
          // (open beside that busy) shows the server recovered, so the run waits again instead of ending
          if (!until) busy = 0;
          else if (last) recovered = true;
          let answers;
          try { answers = StreetIndex.splitAnswer(json, ask); } catch (e) { fail(e, false); return pump(); }
          // the whole answer is in: every tile of it is handed over, whatever the caller throws
          for (const t of ask) {
            const answer = answers.get(t.x + ":" + t.y);
            out.set(t.x + ":" + t.y, answer);
            try { if (onTile) onTile(t, answer); } catch (e) { fail(e, true); }
          }
          pump();
        }), guard((e) => {
          open--;
          if (!e || e.reason !== "busy") fail(e, false);
          else if (!stop) {
            lastBusy = e;
            queue.push(item);
            queue.sort((a, b) => a.rank - b.rank);
            if (until) until = Math.max(until, e.retryAt || 0);
            else if (busy === BUSY_RETRY_MS.length) { last = true; recovered = false; until = Math.max(now() + BUSY_RETRY_MS[0], e.retryAt || 0); }
            else until = Math.max(now() + BUSY_RETRY_MS[busy++], e.retryAt || 0);
          }
          pump();
        }));
      };
      pump();
    });
  };

  // The error a street source or ensureRects rejects with when a tile is missing: how many of the
  // tiles are in (done of total), the failure that stopped the run as `cause`, its
  // retryAt, and reason "streets-partial" once any tile was downloaded (else the cause's own reason).
  // `arrived` is how many this run downloaded and defaults to done: ensureRects counts neither the
  // tiles the index already held nor fresh street-cache answers (onTile's {cached: true}), so an
  // offline run in a partly cached area still says offline.
  // A cause that is itself such an error is unwrapped, so `cause` is always the first failure.
  StreetIndex.downloadError = function (done, total, cause, arrived) {
    const first = cause && typeof cause.total === "number" && cause.cause ? cause.cause : cause;
    const err = new Error(`streets: got ${done} of ${total} tiles` + (first && first.message ? ": " + first.message : ""));
    err.done = done; err.total = total; err.cause = first;
    err.reason = (arrived === undefined ? done : arrived) > 0 ? "streets-partial" : first && first.reason;
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
