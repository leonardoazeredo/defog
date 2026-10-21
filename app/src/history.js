// The History tab and the Send to watch button. The phone app's adapter feeds it (CrossfogPage.history,
// .routeStatus, .linkStatus); everything it asks of the phone goes out through callbacks, so it holds no
// reference to window.crossfog, which the adapter installs after this file has run.
(function (global) {
  const MODE_LABELS = { trekking: "Mountain bike", fastbike: "Road bike", "hiking-mountain": "Walk", walk: "Walk", "car-fast": "Car", shortest: "Direct line" };
  const MIN_PACE_M = 100; // a pace over less ground than this is noise
  const CONFIRM_MS = 5000; // how long the first tap on Delete stays armed

  // ----- formatting (pure) -------------------------------------------------------
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return "–";
    const s = Math.max(0, seconds);
    if (s < 60) return Math.round(s) + " s";
    const minutes = Math.round(s / 60), h = Math.floor(minutes / 60), m = minutes % 60;
    return h > 0 ? h + " h " + String(m).padStart(2, "0") + " min" : m + " min";
  }

  function formatDistance(meters, units) {
    if (!Number.isFinite(meters)) return "–";
    const m = Math.max(0, meters);
    if (units === "imperial") return m >= 160.9344 ? (m / 1609.344).toFixed(1) + " mi" : Math.round(m * 3.28084) + " ft";
    return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
  }

  function paceSecondsPerKm(distanceM, durationS) {
    if (!(distanceM >= MIN_PACE_M) || !(durationS > 0)) return null;
    return durationS / (distanceM / 1000);
  }

  function formatPace(secondsPerKm, units) {
    if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return null;
    const perUnit = units === "imperial" ? secondsPerKm * 1.609344 : secondsPerKm;
    const total = Math.round(perUnit), m = Math.floor(total / 60), s = total % 60;
    return m + ":" + String(s).padStart(2, "0") + (units === "imperial" ? " /mi" : " /km");
  }

  // The mode arrives from the watch as a free string, so an unknown one is shown as it came.
  function modeLabel(travelMode) { return MODE_LABELS[travelMode] || String(travelMode); }

  function formatStart(iso, locale, timeZone) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(d);
  }

  // What a card says under its title: distance and duration always (a dash when missing); pace, steps and heart rate leave their line out when the summary lacks them.
  function statLines(summary, units) {
    const st = summary.stats, lines = [formatDistance(st.distanceM, units), formatDuration(st.durationS)];
    const pace = formatPace(st.paceSPerKm != null ? st.paceSPerKm : paceSecondsPerKm(st.distanceM, st.durationS), units);
    if (pace) lines.push(pace);
    if (st.steps != null) lines.push(Math.round(st.steps) + " steps");
    const heart = [];
    if (st.heartRateAvg != null) heart.push(Math.round(st.heartRateAvg) + " avg");
    if (st.heartRateMax != null) heart.push(Math.round(st.heartRateMax) + " max");
    if (heart.length) lines.push("♥ " + heart.join(" · "));
    return lines;
  }

  // ----- the panel -----------------------------------------------------------------
  // opts: { root, onNeedTrack(id), onDelete(id), onShown(), map, getUnits() }; onShown runs after a track is drawn, so the page can drop the bottom sheet that would hide it
  function create(opts) {
    const root = opts.root, doc = root.ownerDocument, map = opts.map;
    const listEl = root.querySelector("#historyList"), detailEl = root.querySelector("#historyDetail"), emptyEl = root.querySelector("#historyEmpty");
    const units = () => (opts.getUnits ? opts.getUnits() : "metric");
    let items = [];
    let open = null; // { id, points, route } while a card is open
    let overlay = null; // the lines "Show on map" drew
    let armTimer = null;

    // Text only, never markup: the travel mode and every figure come from the watch.
    function el(tag, className, text) {
      const e = doc.createElement(tag);
      if (className) e.className = className;
      if (text != null) e.textContent = text;
      return e;
    }
    function button(text, className, onClick) {
      const b = el("button", className, text);
      b.type = "button";
      b.addEventListener("click", onClick);
      return b;
    }

    function summaryHead(s) {
      const head = el("div", "histTop");
      head.appendChild(el("b", null, modeLabel(s.travelMode)));
      head.appendChild(el("span", "muted", formatStart(s.startedAt)));
      return head;
    }
    function summaryFacts(s) {
      const facts = el("div", "histFacts");
      statLines(s, units()).forEach((t) => facts.appendChild(el("span", null, t)));
      return facts;
    }

    function clearOverlay() {
      if (overlay) overlay.forEach((l) => map.removeLayer(l));
      overlay = null;
    }
    function disarm() { if (armTimer) { global.clearTimeout(armTimer); armTimer = null; } }

    function closeDetail() {
      disarm();
      clearOverlay();
      open = null;
      render();
    }

    function drawOnMap() {
      if (!map.getPane("routes")) { map.createPane("routes"); map.getPane("routes").style.zIndex = 450; }
      const layers = [];
      const route = open.route && open.route.coords && open.route.coords.length >= 2 ? open.route.coords : null;
      // the followed route first, so the walked track draws over it
      if (route) layers.push(global.L.polyline(route.map((c) => [c[1], c[0]]), { pane: "routes", color: "#3b4ad9", weight: 4, opacity: 0.7, dashArray: "6 8", interactive: false }));
      layers.push(global.L.polyline(open.points.map((p) => [p.lat, p.lon]), { pane: "routes", color: "#ff2d55", weight: 4, opacity: 0.95, interactive: false }));
      layers.forEach((l) => l.addTo(map));
      overlay = layers;
      map.fitBounds(layers[layers.length - 1].getBounds(), { padding: [30, 30] });
      if (opts.onShown) opts.onShown();
    }

    function renderDetail() {
      disarm(); // the buttons are rebuilt unarmed, so a pending confirm must not outlive them
      detailEl.textContent = "";
      const s = items.find((x) => x.id === open.id);
      detailEl.appendChild(button("← All activities", "ghost histBack", closeDetail));
      const card = el("div", "card");
      card.appendChild(summaryHead(s));
      card.appendChild(summaryFacts(s));
      if (s.routeId) card.appendChild(el("div", "muted", "Followed a route you planned."));

      const row = el("div", "row");
      const ready = open.points != null && open.points.length > 0;
      const showBtn = button(overlay ? "Hide from map" : "Show on map", "act grow histShow", () => {
        if (overlay) clearOverlay(); else drawOnMap();
        renderDetail();
      });
      showBtn.disabled = !ready;
      row.appendChild(showBtn);

      const delBtn = button("Delete", "ghost grow histDelete", () => {
        if (!armTimer) {
          // First tap arms it; a dialog would block the page.
          delBtn.textContent = "Confirm delete";
          delBtn.classList.add("armed");
          armTimer = global.setTimeout(() => { armTimer = null; delBtn.textContent = "Delete"; delBtn.classList.remove("armed"); }, CONFIRM_MS);
          return;
        }
        const id = open.id;
        closeDetail();
        opts.onDelete(id);
      });
      row.appendChild(delBtn);
      card.appendChild(row);

      if (open.points == null) card.appendChild(el("div", "muted", "Loading the track…"));
      else if (!ready) card.appendChild(el("div", "muted", "This activity recorded no track points."));
      detailEl.appendChild(card);
    }

    function render() {
      const inDetail = open != null;
      listEl.style.display = inDetail ? "none" : "";
      detailEl.style.display = inDetail ? "" : "none";
      emptyEl.style.display = !inDetail && items.length === 0 ? "" : "none";
      if (inDetail) { renderDetail(); return; }
      listEl.textContent = "";
      items.forEach((s) => {
        const card = el("div", "histCard");
        card.setAttribute("role", "button");
        card.tabIndex = 0;
        card.dataset.id = s.id;
        card.appendChild(summaryHead(s));
        card.appendChild(summaryFacts(s));
        const pick = () => openCard(s.id);
        card.addEventListener("click", pick);
        card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
        listEl.appendChild(card);
      });
    }

    function openCard(id) {
      disarm();
      clearOverlay();
      open = { id, points: null, route: null };
      render();
      opts.onNeedTrack(id);
    }

    return {
      // Newest first, whatever order the phone sends.
      setActivities(list) {
        items = list.slice().sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
        if (open && !items.some((x) => x.id === open.id)) { disarm(); clearOverlay(); open = null; }
        render();
      },
      setTrack(activityId, points, route) {
        if (!open || open.id !== activityId) return;
        open.points = points;
        open.route = route || null;
        renderDetail();
      },
      // Card text formats distances and paces in the chosen units, so a toggle needs a re-render.
      refresh() { render(); },
    };
  }

  // ----- Send to watch -------------------------------------------------------------
  const STATUS_TEXT = { waiting: "Waiting for watch", onWatch: "On the watch", failed: "Could not send" };

  // opts: { button, chip, getRecord() -> RouteRecord | null, send(record), canSend() }
  // The chip speaks for the route as it was when sent: an edit or a clear blanks it, and a status for
  // any other route is ignored.
  function createSendControl(opts) {
    const btn = opts.button, chip = opts.chip;
    let sent = null; // { id, gpx } of the record last sent
    let state = null; // waiting | onWatch | failed, for `sent`
    let paired = null;

    function currentIs(rec) { return rec != null && sent != null && rec.id === sent.id && rec.gpx === sent.gpx; }
    function paint() {
      btn.disabled = !(opts.canSend() && opts.getRecord() != null);
      chip.textContent = state ? STATUS_TEXT[state] : paired === false ? "Not paired" : "";
    }

    btn.addEventListener("click", () => {
      const rec = opts.getRecord();
      if (!rec || !opts.canSend()) return;
      sent = { id: rec.id, gpx: rec.gpx };
      state = null;
      opts.send(rec);
      paint();
    });

    return {
      // The route changed (or went away).
      update() {
        if (state && !currentIs(opts.getRecord())) { sent = null; state = null; }
        paint();
      },
      routeStatus(msg) {
        if (!sent || msg.routeId !== sent.id || !STATUS_TEXT[msg.state] || !currentIs(opts.getRecord())) return;
        state = msg.state;
        paint();
      },
      linkStatus(msg) {
        paired = msg.paired;
        paint();
      },
    };
  }

  // Finds the tab's elements and connects them to the phone. `phone()` returns window.crossfog or null:
  // that object is installed after this file has run, so it is looked up at each use.
  // opts: { doc, map, getUnits(), getRecord(), phone(), onShown() }
  function install(opts) {
    const doc = opts.doc, phone = opts.phone;
    const panel = create({
      root: doc.getElementById("historyPane"), map: opts.map, getUnits: opts.getUnits, onShown: opts.onShown,
      onNeedTrack: (id) => { const p = phone(); if (p) p.needTrack(id); },
      onDelete: (id) => { const p = phone(); if (p) p.deleteActivity(id); }
    });
    const send = createSendControl({
      button: doc.getElementById("sendWatch"), chip: doc.getElementById("sendStatus"),
      getRecord: opts.getRecord,
      canSend: () => phone() != null,
      send: (record) => phone().sendRoute(record)
    });
    return { panel, send };
  }

  global.HistoryPanel = { install, create, createSendControl, formatDuration, formatDistance, paceSecondsPerKm, formatPace, modeLabel, formatStart, statLines };
})(window);
