// Overpass endpoints for the street data, shared by suggestions and the "Streets in fog" look so
// they obey one backoff. One request is in flight at a time. overpass-api.de meters every app and
// every IP over a 24 h window and answers 406 once that share is used up, a block until the window
// refills (community.openstreetmap.org/t/overpass-api-performance-issues/140598), so a 406 holds it
// an hour, longer when Retry-After says so; a 429 holds it at least 30 s. NextGIS's keyed Overpass
// goes first by default, and exists only when the page holds a key (the phone app hands it over; a
// browser and the bench have none, and tests set a made-up one). The key is part of its URL, so no
// message or log names the keyed URL. An endpoint that sends no response headers within
// FIRST_BYTE_MS, or not the whole answer within REQUEST_TIMEOUT_MS, is abandoned (a stall) and held
// 30 s, ten minutes from the third stall in a row. A network failure with no readable status (no
// connection, or an answer without CORS headers, which can hide a 429) is held 30 s. The rejection
// names the kind of failure in `reason`, one of five words, for the page to put into words.
(function (global) {
  // no nextgis entry: its URL carries the key, so urlOf builds it at each use
  const ENDPOINTS = {
    main: "https://overpass-api.de/api/interpreter"
  };
  // On the phone a four-tile request took 41-65 s from overpass-api.de and 5-17 s from NextGIS
  // (#185); with no key NextGIS drops out and overpass-api.de is asked alone.
  const DEFAULT_ORDER = ["nextgis", "main"];
  const MIN_BACKOFF_MS = 30000;
  // overpass-api.de sends nothing until a query has waited out its queue and run. On the phone a
  // one-tile request got its first byte after 39-68 s (#185), even a tile of 1 KB, so that is the
  // queue, and the first-byte guard must outlast it. The price is 90 s per dead connection, which
  // is why one stall holds only briefly and the count resets whenever an answer ends.
  const FIRST_BYTE_MS = 90000;
  const REQUEST_TIMEOUT_MS = 120000;
  const STALLS_BEFORE_LONG_HOLD = 3;
  const STALL_HOLD_MS = 600000;
  const BAN_HOLD_MS = 3600000;
  const BUSY_STATUS = { 429: true, 502: true, 504: true };
  // most actionable first: when the endpoints disagree, the rejection carries the first of these
  const REASONS = ["blocked", "busy", "stalled", "offline", "server"];

  let order = DEFAULT_ORDER.slice();

  // Read at each use: window.crossfogNextgisKey is set by the script mobile/src/bridge/pageConfig.ts
  // builds and WebShell.tsx injects, and on Android that can land after this file has run.
  function urlOf(name) {
    if (name !== "nextgis") return ENDPOINTS[name];
    const key = global.crossfogNextgisKey;
    return typeof key === "string" && key ? "https://overpass.nextgis.com/" + encodeURIComponent(key) + "/api/interpreter" : undefined;
  }
  let state = {}; // url -> {until: time before which it is not asked again, why: that hold's reason, error: the failure that earned it, stalls: in a row}
  let queue = Promise.resolve();

  const stateOf = (url) => state[url] || (state[url] = { until: 0, why: null, error: null, stalls: 0 });

  // A browser exposes Retry-After to page script only if the server lists it in
  // Access-Control-Expose-Headers, and an HTTP-date value is not parsed: either way the floor
  // applies (30 s for a 429, an hour for a 406).
  function retryAfterMs(res) {
    const secs = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
    return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
  }

  // One request: the headers within FIRST_BYTE_MS, the whole body within REQUEST_TIMEOUT_MS of the
  // start, one AbortController for both. Resolves with {status, json} on success,
  // {status, error, retryAfter} on a non-2xx answer, or {error, kind: "stall" | "network" |
  // "notJson", status?} otherwise; never rejects.
  async function attempt(url, body) {
    const ctrl = new AbortController();
    const started = Overpass._now();
    const stall = (what) => () => ctrl.abort(new Error("overpass: " + what));
    let timer = Overpass._setTimeout(stall("no answer within " + Overpass._firstByteMs / 1000 + " s"), Overpass._firstByteMs);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        // UA is for the Node benchmark harness (Overpass rejects Node's default). Page script
        // cannot set it in a browser; in the app Overpass sees the WebView's UA, which
        // contains the "CrossTheFog/<version>" name WebShell.tsx adds.
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "FogToMaps/1.0 (defog route suggestions)" },
        body,
        signal: ctrl.signal
      });
    } catch (e) {
      Overpass._clearTimeout(timer);
      return { error: e, kind: ctrl.signal.aborted ? "stall" : "network" };
    }
    Overpass._clearTimeout(timer);
    if (!res.ok) return { status: res.status, error: new Error("overpass HTTP " + res.status), retryAfter: retryAfterMs(res) };
    timer = Overpass._setTimeout(stall("body stopped"), Math.max(0, Overpass._timeoutMs - (Overpass._now() - started)));
    try {
      return { status: res.status, json: await res.json() };
    } catch (e) {
      // A SyntaxError before our abort means a 200 whose body is not JSON (a captive portal, a
      // proxy): like a 500, it moves on at once. After our abort the parser can also report a
      // SyntaxError on the cut-off text, which is a stall. Matched by name, not instanceof,
      // because WebKit rejects with a DOMException named SyntaxError. Anything else is the body
      // stopping (our abort, a dropped connection), and both count as a stall: an endpoint that
      // keeps cutting answers off is as useless as a silent one.
      return { status: res.status, error: e, kind: !ctrl.signal.aborted && e.name === "SyntaxError" ? "notJson" : "stall" };
    } finally {
      Overpass._clearTimeout(timer);
    }
  }

  async function tryEndpoints(body) {
    const now = Overpass._now();
    const urls = order.map(urlOf).filter(Boolean);
    // one {why, error} per endpoint, a held one contributing its hold's: the error thrown is always
    // the one that earned the reason, never another endpoint's; only the reason offline can fall back
    // to the synthetic browser-offline error
    const failures = [];
    let anyStatus = false;
    for (const url of urls) {
      const s = stateOf(url);
      if (s.until > now) { failures.push({ why: s.why, error: s.error }); continue; }
      const r = await attempt(url, body);
      // a body stall carries its 200, but only an answer that ended proves the endpoint alive
      if (r.status !== undefined) { anyStatus = true; if (r.kind !== "stall") s.stalls = 0; }
      if (r.json !== undefined) return r.json;
      let why, holdMs = 0;
      if (r.kind === "stall") { s.stalls++; why = "stalled"; holdMs = s.stalls >= STALLS_BEFORE_LONG_HOLD ? STALL_HOLD_MS : MIN_BACKOFF_MS; }
      else if (r.kind === "network") { why = "offline"; holdMs = MIN_BACKOFF_MS; }
      else if (r.status === 406) { why = "blocked"; holdMs = Math.max(BAN_HOLD_MS, r.retryAfter); }
      else if (r.status === 429) { why = "busy"; holdMs = Math.max(MIN_BACKOFF_MS, r.retryAfter); }
      else why = BUSY_STATUS[r.status] ? "busy" : "server";
      if (holdMs) { s.until = Overpass._now() + holdMs; s.why = why; s.error = r.error; }
      failures.push({ why, error: r.error });
    }
    // a failed fetch means offline only when nothing answered at all: a status proves the network up
    for (const f of failures) if (f.why === "offline" && anyStatus) f.why = "server";
    if (typeof navigator !== "undefined" && navigator.onLine === false) failures.push({ why: "offline", error: new Error("overpass: the browser is offline") });
    const reason = REASONS.find((r) => failures.some((f) => f.why === r)) || "server";
    const winner = failures.find((f) => f.why === reason);
    const err = (winner && winner.error) || new Error("overpass: no endpoint to ask");
    err.reason = reason;
    // a held endpoint's error is thrown again by later posts, so a retry time from an earlier one must go
    const held = urls.map(stateOf).filter((s) => s.until > Overpass._now());
    // a 406 is this network's daily cap and BLOCKED_ADVICE tells the person to try tomorrow, so a
    // blocked retryAt is the block's own end, even when another endpoint's hold ends sooner; the
    // streets layer waits for it
    const until = held.filter((s) => reason !== "blocked" || s.why === "blocked").map((s) => s.until);
    if (held.length === urls.length) err.retryAt = Math.min(...until);
    else delete err.retryAt;
    throw err;
  }

  // Resolves with the JSON of the first endpoint, in order, whose body parses. Rejects with the
  // error that earned the reason, carrying `reason` and `retryAt`. When the endpoints disagree the
  // first reason in this list wins, most actionable first. The reasons: blocked, a 406 was seen or an
  // endpoint is held after one; busy, 429, 502 or 504; stalled, no answer or a body that stopped;
  // offline, the browser says so, or every fetch failed and no status was seen; server, anything
  // else. `retryAt` (on the Overpass._now clock) is set only when every endpoint is on hold: the end of
  // the first hold, before which no post goes out; when the reason is blocked, the end of the earliest
  // block instead, which can come after another endpoint's hold ends: a post in between still goes out.
  function post(body) {
    const run = queue.then(() => tryEndpoints(body));
    queue = run.catch(() => {});
    return run;
  }

  const Overpass = {
    ENDPOINTS,
    // the names given first, in their order and without repeats, then the rest of the default. An
    // order naming an endpoint not in DEFAULT_ORDER is a stale choice, so it reads as the default
    // whole rather than promoting whatever follows the unknown name.
    setOrder(keys) {
      const known = keys.every((k) => DEFAULT_ORDER.includes(k)) ? keys.filter((k, i) => keys.indexOf(k) === i) : [];
      order = known.concat(DEFAULT_ORDER.filter((k) => !known.includes(k)));
    },
    // whether a post can reach this endpoint: false for an unknown name, and for nextgis while the
    // page holds no key
    has: (name) => !!urlOf(name),
    post,
    // test-only hooks, used between settled posts: a fake clock, fake timers, the two limits, and a
    // way back to the initial state
    _now: () => Date.now(),
    _setTimeout: (fn, ms) => setTimeout(fn, ms),
    _clearTimeout: (timer) => clearTimeout(timer),
    _firstByteMs: FIRST_BYTE_MS,
    _timeoutMs: REQUEST_TIMEOUT_MS,
    _reset() {
      order = DEFAULT_ORDER.slice(); state = {}; queue = Promise.resolve();
      Overpass._now = () => Date.now();
      Overpass._setTimeout = (fn, ms) => setTimeout(fn, ms); Overpass._clearTimeout = (timer) => clearTimeout(timer);
      Overpass._firstByteMs = FIRST_BYTE_MS; Overpass._timeoutMs = REQUEST_TIMEOUT_MS;
    }
  };
  global.Overpass = Overpass;
})(window);
