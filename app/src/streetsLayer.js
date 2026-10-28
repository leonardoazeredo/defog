// "Streets in fog": lights up the streets and paths still covered by fog.
//
// Street geometry for the area on screen comes from the shared StreetIndex, read
// from the streets already on the device: a pan never downloads. Pieces of the
// view not on the device are counted in the badge, and its "Download this area"
// button is the one thing that fetches them (Overpass meters each app per day).
// Each way is judged in ~20 m pieces against the fog: a piece is still "left"
// when no defogged cell lies within DONE_WITHIN_M of it, the same idea the
// route editor uses to split a drawn path into new and already-done ground.
// Consecutive left pieces become a run, and only the runs are drawn, so a
// street you've half walked lights up along its missing half only.
//
// Drawing is a glow: a wide translucent halo under a thin bright core, on a
// canvas pane between the fog and the route overlays. The colour is the user's
// own, deepened a little on a light map, and never the fog swatch colour, which
// would read as "already defogged". Stretches the chosen way of travelling
// can't take are drawn faintly rather than dropped, so a walk-only alley still
// shows while you're planning a bike ride.
(function (global) {
  const MAX_TILES = 48;      // no higher: the shared index evicts nothing under a pass while it runs, so past its MAX_SEGS the view's own ways are cut short
  const FETCH_MAX_TILES = 16; // the most missing pieces one tap downloads
  const PIECE_M = 20;        // ways are judged in pieces this long
  const DONE_WITHIN_M = 20;  // a piece is done if a defogged cell lies this close (forgives GPS wobble)
  const MIN_RUN_M = 25;      // shorter leftover stretches aren't drawn (confetti at crossings)
  const SLICE_MS = 12;       // classify in slices this long so big cities don't freeze the page
  // One colour serves both maps: as-is on the dark map, deepened a little on the
  // light one so it still reads against pale ground while staying bright.
  const DEFAULT_COLOR = "#4fd6e6";
  const OPS = {
    light: { coreOp: 0.78, haloOp: 0.14, shade: 0.82 },
    dark: { coreOp: 0.9, haloOp: 0.3, shade: 1 }
  };
  const DIM_OP = 0.45; // strength of stretches the chosen transport can't use
  // Which travel class each Plan mode needs; the rest can go anywhere on foot.
  const MODE_CLASS = global.StreetIndex.MODE_CLASS;
  function shade(hex, f) {
    const h = hex.replace("#", "");
    const c = [0, 2, 4].map((i) => Math.round(parseInt(h.substr(i, 2), 16) * f));
    return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  // Zoomed in on a light map the basemap's own streets are wide and colourful, so
  // the highlight needs more line to hold its own. Zoomed out both maps read fine.
  const coreWeight = (z, look) => {
    const w = z <= 13 ? 2 : z <= 15 ? 2.5 : 3;
    return look === "light" && z >= 14 ? w + 1 : w;
  };
  const HALO_EXTRA = 4;
  // a bug, not a download: the street servers have nothing to do with it
  const INTERNAL = "Something went wrong while showing the street map. Reload the page and try again.";

  const Badge = L.Control.extend({
    onAdd: function () {
      const d = L.DomUtil.create("div", "streetsBadge");
      d.style.display = "none";
      L.DomEvent.disableClickPropagation(d);
      return d;
    }
  });

  function StreetsInFogLayer(map, opts) {
    this.map = map;
    this.streets = opts.streets;   // shared StreetIndex
    this.isNew = opts.isNew;       // (lon, lat, radiusM) -> true when no defogged cell is within radius
    this.onStats = opts.onStats || null; // called whenever what's drawn changes (for the header readout)
    this.enabled = false;
    this.look = "light";
    this.color = DEFAULT_COLOR;
    this.opacity = 1;
    this.travelClass = null;       // null = draw every stretch at full strength
    this.runs = [];                // stretches still to do: [{ll: [[lat, lng], ...], m, s, w, n, e}]
    this.doneRuns = [];            // stretches already defogged (kept for the "% of streets in fog" readout)
    this._cursor = 0;              // how many of streets.ways have been classified
    this._wayEpoch = this.streets.wayEpoch; // the index's epoch the runs were made under
    this._followIndex();
    this._busy = false; this._dirty = false;
    this._missingRects = [];       // rects of the view's pieces not on the device, what the button downloads
    this._known = 0;               // how many of the view's pieces are on the device, counted done by the button's download
    this._fetching = false;        // the button's download is running
    this._failure = null;          // its failure's wording, kept until the map moves
    this._view = 0;                // bumped by each move, so a download finishing late cannot word the new view
    this._tooBig = false;          // the view is past MAX_TILES
    this._pass = 0;                // bumped by each _update, so a pass still reading cannot paint over a newer one
    if (!map.getPane("streets")) {
      map.createPane("streets");
      map.getPane("streets").style.zIndex = 360; // above the fog (350), below routes (400)
    }
    const renderer = L.canvas({ pane: "streets" });
    // faint stretches first, so the ones you can actually take draw over them
    this.dim = L.polyline([], { renderer, pane: "streets", interactive: false, lineCap: "round", lineJoin: "round" });
    this.halo = L.polyline([], { renderer, pane: "streets", interactive: false, lineCap: "round", lineJoin: "round" });
    this.core = L.polyline([], { renderer, pane: "streets", interactive: false, lineCap: "round", lineJoin: "round" });
    this.badge = new Badge({ position: "topright" });
    this._onMove = () => this._moved();
  }

  // a failure's text and its Try again button belong to the view they happened in
  StreetsInFogLayer.prototype._moved = function () {
    this._view++;
    this._failure = null;
    this._update();
  };

  StreetsInFogLayer.prototype.setEnabled = function (on) {
    if (on === this.enabled) return;
    this.enabled = on;
    // the map can move unseen while the look is off
    this._view++;
    this._failure = null;
    if (on) {
      this.dim.addTo(this.map); this.halo.addTo(this.map); this.core.addTo(this.map);
      this.badge.addTo(this.map);
      this.map.on("moveend", this._onMove);
      this._restyle();
      this._update();
    } else {
      this.map.off("moveend", this._onMove);
      this.map.removeLayer(this.dim); this.map.removeLayer(this.halo); this.map.removeLayer(this.core);
      this.map.removeControl(this.badge);
    }
  };

  // look: "dark" | "light", matching the basemap
  StreetsInFogLayer.prototype.setLook = function (look) {
    this.look = OPS[look] ? look : "light";
    this._restyle();
  };
  // Plan-tab transport mode: stretches it can't use are drawn faintly.
  StreetsInFogLayer.prototype.setMode = function (profile) {
    const c = MODE_CLASS[profile] || null;
    if (c === this.travelClass) return;
    this.travelClass = c;
    if (this.enabled) this._draw();
  };
  StreetsInFogLayer.prototype.setColor = function (hex) {
    this.color = /^#[0-9a-f]{6}$/i.test(hex || "") ? hex : DEFAULT_COLOR;
    this._restyle();
  };
  // The colour the streets are drawn in right now (the header readout matches it).
  StreetsInFogLayer.prototype.currentColor = function () {
    return shade(this.color, OPS[this.look].shade);
  };
  StreetsInFogLayer.prototype.setOpacity = function (a) {
    this.opacity = Math.max(0, Math.min(1, a));
    this._restyle();
  };

  // A suggestion's or a route's run can replace ways drawn here, and nothing else would repaint them.
  StreetsInFogLayer.prototype._followIndex = function () {
    this.streets.onWaysChanged = () => this.refresh();
  };

  // Recount what is on the device: once main.js swaps in the street cache, and after a run replaces ways (see _followIndex).
  StreetsInFogLayer.prototype.refresh = function () {
    if (this.enabled) this._update();
  };

  // The fog changed (more tiles loaded): every way needs judging again.
  StreetsInFogLayer.prototype.invalidateFog = function () {
    this._rejudge();
    if (this.enabled) this._update();
  };

  // runs and cursor go together, and both are valid only for the index epoch recorded here
  StreetsInFogLayer.prototype._rejudge = function () {
    this.runs = []; this.doneRuns = []; this._cursor = 0;
    this._wayEpoch = this.streets.wayEpoch;
  };

  StreetsInFogLayer.prototype._restyle = function () {
    if (!this.enabled) return;
    const lk = OPS[this.look], w = coreWeight(this.map.getZoom(), this.look), c = this.currentColor();
    this.core.setStyle({ color: c, opacity: lk.coreOp * this.opacity, weight: w });
    this.halo.setStyle({ color: c, opacity: lk.haloOp * this.opacity, weight: w + HALO_EXTRA });
    this.dim.setStyle({ color: c, opacity: lk.coreOp * this.opacity * DIM_OP, weight: Math.max(1, w - 0.5) });
  };

  // Metres of street still to do / already done inside the given bounds, counting
  // each 20 m piece by its midpoint. Only meaningful for the area already fetched.
  StreetsInFogLayer.prototype.statsInView = function (b) {
    const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    const ky = 110540, kx = 111320 * Math.cos(((s + n) / 2) * Math.PI / 180);
    const sum = (list) => {
      let m = 0;
      for (const r of list) {
        if (r.n < s || r.s > n || r.e < w || r.w > e) continue;
        const ll = r.ll;
        for (let i = 1; i < ll.length; i++) {
          const la = (ll[i - 1][0] + ll[i][0]) / 2, lo = (ll[i - 1][1] + ll[i][1]) / 2;
          if (la < s || la > n || lo < w || lo > e) continue;
          m += Math.hypot((ll[i][1] - ll[i - 1][1]) * kx, (ll[i][0] - ll[i - 1][0]) * ky);
        }
      }
      return m;
    };
    return { leftM: sum(this.runs), doneM: sum(this.doneRuns) };
  };

  // action: {label, run} for the badge's one button, or nothing
  StreetsInFogLayer.prototype._say = function (text, action) {
    const el = this.badge.getContainer();
    if (!el) return;
    el.textContent = text || "";
    if (text && action) {
      const b = L.DomUtil.create("button", "streetsBadgeBtn", el);
      b.type = "button";
      b.textContent = action.label;
      L.DomEvent.on(b, "click", action.run);
    }
    el.style.display = text ? "" : "none";
  };

  // Tiles of the shared street grid touching the current view, as rects.
  StreetsInFogLayer.prototype._visibleTiles = function () {
    const b = this.map.getBounds();
    return global.StreetIndex.tilesCovering({ s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() })
      .map(global.StreetIndex.tileBounds);
  };

  // Never rejects: most callers (a move, a switch, the cache opening) do not await it.
  StreetsInFogLayer.prototype._update = async function () {
    if (!this.enabled) return;
    const pass = ++this._pass;
    const current = () => this.enabled && pass === this._pass;
    try {
      const tiles = this._visibleTiles();
      this._tooBig = tiles.length > MAX_TILES;
      if (this._tooBig) {
        this._say("Zoom in to see the streets in fog (about a town at a time)");
        this.dim.setLatLngs([]); this.halo.setLatLngs([]); this.core.setLatLngs([]);
        return;
      }
      if (this._busy) { this._dirty = true; return; }
      this._busy = true;
      try {
        const cached = await this.streets.ensureRects(tiles, "run", { cacheOnly: true });
        if (!current()) return;
        this._missingRects = cached.missing.map(global.StreetIndex.tileBounds);
        this._known = cached.done;
        await this._classifyNew();
        if (!current()) return;
        this._draw();
        if (!this._fetching) this._sayKnown(tiles.length);
      } finally {
        this._busy = false;
        if (this._dirty) { this._dirty = false; this._update(); }
      }
    } catch (e) {
      // nothing here downloads, so whatever threw is a bug (the class only, messages name tiles)
      console.error("[streets layer] showing streets threw", e && e.name);
      if (current() && !this._fetching) this._say(INTERNAL);
    }
  };

  StreetsInFogLayer.prototype._sayKnown = function (n) {
    const missing = this._missingRects.length, known = "Street map known for " + (n - missing) + " of " + n + " pieces here.";
    const button = (label) => ({ label, run: () => this._download() });
    if (this._failure) this._say(this._failure, missing ? button("Try again") : null);
    else if (!missing) this._say("");
    else if (missing > FETCH_MAX_TILES) this._say(known + " Zoom in to download the rest.");
    else this._say(known, button("Download this area"));
  };

  // The button: the normal download of the pieces the badge counted, never more than
  // FETCH_MAX_TILES pieces; a failure waits for the next tap, there is no quiet retry.
  StreetsInFogLayer.prototype._download = async function () {
    // the download asks only for the missing pieces, but its count is the view's, as the badge's is:
    // the pieces already on the device (known) are done, so a retry shows the same total
    const rects = this._missingRects, view = this._view, known = this._known;
    if (this._fetching || !this.enabled || this._tooBig || !rects.length || rects.length > FETCH_MAX_TILES) return;
    this._fetching = true;
    this._failure = null;
    // switched off or zoomed out mid-download: a late count must not replace that badge
    const onProgress = ({ done, total, waitUntil }) => {
      if (this.enabled && !this._tooBig) this._say(global.StreetMessages.progress(done + known, total + known, waitUntil, Date.now()));
    };
    // the download belongs to the view it was tapped in: once the map moves or the look is switched off
    // it asks nothing further, so it does not keep the server busy through its busy waits
    const stale = () => view !== this._view || !this.enabled;
    try { await this.streets.ensureRects(rects, "run", { onProgress, stale }); }
    catch (e) {
      const download = global.StreetIndex.isDownloadError(e);
      if (!download) console.error("[streets layer] downloading streets threw", e && e.name);
      else if (view === this._view) console.warn("[streets layer] streets unavailable", e.reason);
      // no retry time: the badge stays up with nothing to count it down, and the button is the retry
      if (view === this._view) {
        const facts = download && global.StreetIndex.downloadFacts(e);
        this._failure = download ? global.StreetMessages.describe(Object.assign(facts, { done: facts.done + known, total: facts.total + known, retryAt: null })) : INTERNAL;
      }
    } finally {
      this._fetching = false;
    }
    await this._update();
  };

  // Judge the ways fetched since last time, in short time slices. Yields through a
  // message channel rather than a timer or animation frame: those are throttled
  // or paused in a background tab, and this should finish there too.
  StreetsInFogLayer.prototype._classifyNew = function () {
    return new Promise((resolve, reject) => {
      const ch = new MessageChannel();
      const finish = (settle, v) => { ch.port1.close(); settle(v); };
      // a throw in a later slice runs from onmessage, outside the promise: it must reject by hand
      const step = () => {
        try {
          // a fresh answer replaced or dropped ways and the index does not say which: judge every way again
          if (this._wayEpoch !== this.streets.wayEpoch) this._rejudge();
          const ways = this.streets.ways, t0 = performance.now();
          while (this._cursor < ways.length && performance.now() - t0 < SLICE_MS) this._classifyWay(ways[this._cursor++]);
          if (this._cursor < ways.length) ch.port2.postMessage(null); else finish(resolve);
        } catch (e) { finish(reject, e); }
      };
      ch.port1.onmessage = step;
      step();
    });
  };

  // Split one way into runs of consecutive "left" pieces and consecutive "done" pieces.
  StreetsInFogLayer.prototype._classifyWay = function (w) {
    const g = w.geometry;
    const ky = 110540, kx = 111320 * Math.cos(g[0].lat * Math.PI / 180);
    let run = null, runM = 0, runLeft = false;
    const close = () => {
      if (run) {
        let s = 90, n = -90, ww = 180, e = -180;
        for (const p of run) { if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0]; if (p[1] < ww) ww = p[1]; if (p[1] > e) e = p[1]; }
        (runLeft ? this.runs : this.doneRuns).push({ id: w.id, ll: run, m: runM, s, n, w: ww, e });
      }
      run = null; runM = 0;
    };
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1], b = g[i];
      const edgeM = Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * ky);
      const pieces = Math.max(1, Math.ceil(edgeM / PIECE_M)), pieceM = edgeM / pieces;
      for (let p = 0; p < pieces; p++) {
        const tm = (p + 0.5) / pieces;
        const left = this.isNew(a.lon + (b.lon - a.lon) * tm, a.lat + (b.lat - a.lat) * tm, DONE_WITHIN_M);
        if (run && left !== runLeft) close();
        if (!run) {
          const t0 = p / pieces;
          runLeft = left;
          run = [[a.lat + (b.lat - a.lat) * t0, a.lon + (b.lon - a.lon) * t0]];
        }
        const t1 = (p + 1) / pieces;
        run.push([a.lat + (b.lat - a.lat) * t1, a.lon + (b.lon - a.lon) * t1]);
        runM += pieceM;
      }
    }
    close();
  };

  // Draw the runs near the view (a margin so a small pan doesn't show edges).
  StreetsInFogLayer.prototype._draw = function () {
    const b = this.map.getBounds().pad(0.2);
    const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    // a way we haven't classified yet counts as usable, so nothing fades in late
    const usable = (id) => (this.travelClass === "car" || !this.streets.motorway.has(id)) &&
      (!this.travelClass || !this.streets.classified.has(id) || this.streets.classIds[this.travelClass].has(id));
    const shown = [], faint = [];
    for (const r of this.runs)
      if (r.m >= MIN_RUN_M && r.n >= s && r.s <= n && r.e >= w && r.w <= e) (usable(r.id) ? shown : faint).push(r.ll);
    this._restyle();
    this.dim.setLatLngs(faint);
    this.halo.setLatLngs(shown);
    this.core.setLatLngs(shown);
    if (this.onStats) this.onStats();
  };

  StreetsInFogLayer.MAX_TILES = MAX_TILES;
  StreetsInFogLayer.FETCH_MAX_TILES = FETCH_MAX_TILES;
  global.StreetsInFogLayer = StreetsInFogLayer;
})(window);
