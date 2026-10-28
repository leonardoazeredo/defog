// The History tab and the Send to watch button. The phone app's adapter feeds it (CrossfogPage.history,
// .routeStatus, .linkStatus); everything it asks of the phone goes out through callbacks, so it holds no
// reference to window.crossfog, which the adapter installs after this file has run.
(function (global) {
  const MODE_LABELS = { trekking: "Mountain bike", fastbike: "Road bike", "hiking-mountain": "Walk", walk: "Walk", "car-fast": "Car", shortest: "Direct line" };
  const MIN_PACE_M = 100; // a pace over less ground than this is noise
  const CONFIRM_MS = 5000; // how long the first tap on Delete stays armed
  // How long a track or a route send waits for the phone's first answer. Both are a local read or write,
  // well under a second; a needTrack the phone drops as malformed, a dropped sendRoute whose id is no UUID,
  // or a lost message gets no answer at all.
  const REPLY_TIMEOUT_MS = 15000;
  const TRACK_NOTES = {
    notFound: "This activity is no longer on the phone.",
    readFailed: "The phone could not read this track.",
    timeout: "The phone did not send the track. Go back and open the activity again.",
    offline: "This page is not running in the app, so the track cannot be loaded."
  };
  const DELETE_OFFLINE = "This page is not running in the app, so nothing was deleted.";

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
  // opts: { root, onNeedTrack(id), onDelete(id), onShown(), map, getUnits() }; onShown runs after a track is drawn, so the page can drop the bottom sheet that would hide it.
  // onNeedTrack and onDelete return false when there is no phone to ask; anything else counts as asked.
  function create(opts) {
    const root = opts.root, doc = root.ownerDocument, map = opts.map;
    const listEl = root.querySelector("#historyList"), detailEl = root.querySelector("#historyDetail"), emptyEl = root.querySelector("#historyEmpty");
    const units = () => (opts.getUnits ? opts.getUnits() : "metric");
    let items = [];
    let open = null; // { id, points, route, trackNote, deleteNote } while a card is open
    let overlay = null; // the lines "Show on map" drew
    let armTimer = null;
    let trackTimer = null;

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
    function stopWaiting() { if (trackTimer) { global.clearTimeout(trackTimer); trackTimer = null; } }

    function closeDetail() {
      disarm();
      stopWaiting();
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
      if (!s) { closeDetail(); return; }
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
        if (opts.onDelete(open.id) === false) {
          open.deleteNote = DELETE_OFFLINE;
          renderDetail();
          return;
        }
        closeDetail();
      });
      row.appendChild(delBtn);
      card.appendChild(row);

      if (open.deleteNote) card.appendChild(el("div", "muted", open.deleteNote));
      if (open.points == null) card.appendChild(el("div", "muted", open.trackNote || "Loading the track…"));
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

    // Replaces "Loading the track…" with why no track is coming; ignored once points arrived or the card moved on.
    function noteTrack(activityId, note) {
      if (!open || open.id !== activityId || open.points != null) return;
      stopWaiting();
      open.trackNote = note;
      renderDetail();
    }

    function openCard(id) {
      disarm();
      stopWaiting();
      clearOverlay();
      open = { id, points: null, route: null, trackNote: null, deleteNote: null };
      render();
      let asked;
      try {
        asked = opts.onNeedTrack(id);
      } catch (e) {
        console.error("crossfog: could not ask the phone for a track", e instanceof Error ? e.name : typeof e);
        noteTrack(id, TRACK_NOTES.timeout);
        return;
      }
      if (asked === false) { noteTrack(id, TRACK_NOTES.offline); return; }
      trackTimer = global.setTimeout(() => { trackTimer = null; noteTrack(id, TRACK_NOTES.timeout); }, REPLY_TIMEOUT_MS);
    }

    return {
      // Newest first, whatever order the phone sends.
      setActivities(list) {
        items = list.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
        if (open && !items.some((x) => x.id === open.id)) { disarm(); stopWaiting(); clearOverlay(); open = null; }
        render();
      },
      // A track that comes after the timeout still shows.
      setTrack(activityId, points, route) {
        if (!open || open.id !== activityId) return;
        stopWaiting();
        open.points = points;
        open.route = route || null;
        renderDetail();
      },
      // The phone's answer to a needTrack it has no track for; reason is notFound or readFailed.
      trackUnavailable(activityId, reason) { noteTrack(activityId, TRACK_NOTES[reason] || TRACK_NOTES.readFailed); },
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
    let replyTimer = null;

    // A record that cannot be built (no crypto, a bad route) leaves the button off; it must not break the route UI that called update().
    function record() {
      try { return opts.getRecord(); }
      catch (e) { console.error("crossfog: could not build the route record"); return null; }
    }
    function currentIs(rec) { return rec != null && sent != null && rec.id === sent.id && rec.gpx === sent.gpx; }
    function paint() {
      btn.disabled = !(opts.canSend() && record() != null);
      chip.textContent = state ? STATUS_TEXT[state] : paired === false ? "Not paired" : "";
    }

    btn.addEventListener("click", () => {
      const rec = record();
      if (!rec || !opts.canSend()) return;
      sent = { id: rec.id, gpx: rec.gpx };
      state = null;
      if (replyTimer) global.clearTimeout(replyTimer);
      replyTimer = null;
      try {
        opts.send(rec);
        // No answer at all means the phone never took the route; a "waiting" answer is not timed out, as the watch may connect much later.
        replyTimer = global.setTimeout(() => {
          replyTimer = null;
          if (state === null && currentIs(record())) { state = "failed"; paint(); }
        }, REPLY_TIMEOUT_MS);
      } catch (e) {
        console.error("crossfog: could not hand the route to the phone", e instanceof Error ? e.name : typeof e);
        state = "failed";
      }
      paint();
    });

    return {
      // The route changed (or went away).
      update() {
        if (state && !currentIs(record())) { sent = null; state = null; }
        paint();
      },
      routeStatus(msg) {
        if (!sent || msg.routeId !== sent.id || !STATUS_TEXT[msg.state] || !currentIs(record())) return;
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
      onNeedTrack: (id) => { const p = phone(); if (!p) return false; p.needTrack(id); return true; },
      onDelete: (id) => { const p = phone(); if (!p) return false; p.deleteActivity(id); return true; }
    });
    const send = createSendControl({
      button: doc.getElementById("sendWatch"), chip: doc.getElementById("sendStatus"),
      getRecord: opts.getRecord,
      canSend: () => phone() != null,
      send: (record) => phone().sendRoute(record)
    });
    return { panel, send };
  }

  global.HistoryPanel = { REPLY_TIMEOUT_MS, install, create, createSendControl, formatDuration, formatDistance, paceSecondsPerKm, formatPace, modeLabel, formatStart, statLines };
})(window);
