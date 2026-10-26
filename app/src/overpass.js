// Overpass endpoints for the street data, shared by suggestions and the "Streets in fog" look so
// they obey one backoff. One request is in flight at a time. overpass-api.de goes first: it meters
// every app and every IP over a 24 h window and answers 406 once that share is used up, a block
// until the window refills (community.openstreetmap.org/t/overpass-api-performance-issues/140598),
// so a 406 holds it an hour, longer when Retry-After says so; a 429 holds it at least 30 s.
// overpass.private.coffee can accept a connection and then send nothing for long stretches, so an
// endpoint that sends no response headers within FIRST_BYTE_MS, or not the whole answer within
// REQUEST_TIMEOUT_MS, is abandoned (a stall) and held 30 s, ten minutes from the third stall in a
// row. A network failure with no readable status (no connection, or an answer without CORS
// headers, which can hide a 429) is held 30 s. The rejection names the kind of failure in
// `reason`, one of five words, for the page to put into words.
(function (global) {
  const ENDPOINTS = {
    coffee: "https://overpass.private.coffee/api/interpreter",
    main: "https://overpass-api.de/api/interpreter"
  };
  const DEFAULT_ORDER = ["main", "coffee"];
  const MIN_BACKOFF_MS = 30000;
  // Overpass sends nothing until the query has run, so a real answer that takes 16 s trips this
  // guard like a dead connection does; that is why one stall holds only briefly and the count
  // resets whenever an answer ends.
  const FIRST_BYTE_MS = 15000;
  const REQUEST_TIMEOUT_MS = 30000;
  const STALLS_BEFORE_LONG_HOLD = 3;
  const STALL_HOLD_MS = 600000;
  const BAN_HOLD_MS = 3600000;
  const BUSY_STATUS = { 429: true, 502: true, 504: true };
  // most actionable first: when the endpoints disagree, the rejection carries the first of these
  const REASONS = ["blocked", "busy", "stalled", "offline", "server"];

  let order = DEFAULT_ORDER.slice();
  let state = {}; // url -> {until: time before which it is not asked again, why: that hold's reason, stalls: in a row}
  let queue = Promise.resolve();

  const stateOf = (url) => state[url] || (state[url] = { until: 0, why: null, stalls: 0 });

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
    let lastError = null;
    const said = []; // one reason per endpoint, a held one contributing its hold's
    let anyStatus = false;
    for (const key of order) {
      const url = ENDPOINTS[key];
      const s = stateOf(url);
      if (s.until > now) { said.push(s.why); continue; }
      const r = await attempt(url, body);
      // a body stall carries its 200, but only an answer that ended proves the endpoint alive
      if (r.status !== undefined) { anyStatus = true; if (r.kind !== "stall") s.stalls = 0; }
      if (r.json !== undefined) return r.json;
      lastError = r.error;
      let why, holdMs = 0;
      if (r.kind === "stall") { s.stalls++; why = "stalled"; holdMs = s.stalls >= STALLS_BEFORE_LONG_HOLD ? STALL_HOLD_MS : MIN_BACKOFF_MS; }
      else if (r.kind === "network") { why = "offline"; holdMs = MIN_BACKOFF_MS; }
      else if (r.status === 406) { why = "blocked"; holdMs = Math.max(BAN_HOLD_MS, r.retryAfter); }
      else if (r.status === 429) { why = "busy"; holdMs = Math.max(MIN_BACKOFF_MS, r.retryAfter); }
      else why = BUSY_STATUS[r.status] ? "busy" : "server";
      if (holdMs) { s.until = Overpass._now() + holdMs; s.why = why; }
      said.push(why);
    }
    const err = lastError || new Error("overpass: every endpoint is on hold");
    // a failed fetch means offline only when nothing answered at all: a status proves the network up
    const reasons = said.map((why) => why === "offline" && anyStatus ? "server" : why);
    if (typeof navigator !== "undefined" && navigator.onLine === false) reasons.push("offline");
    err.reason = REASONS.find((r) => reasons.includes(r)) || "server";
    const later = order.map((k) => stateOf(ENDPOINTS[k]).until).filter((at) => at > Overpass._now());
    if (later.length === order.length) err.retryAt = Math.min(...later);
    throw err;
  }

  // Resolves with the JSON of the first endpoint, in order, whose body parses. Rejects with the
  // last error, carrying `reason` and `retryAt`. When the endpoints disagree the first reason in
  // this list wins, most actionable first. The reasons: blocked, a 406 was seen or an
  // endpoint is held after one; busy, 429, 502 or 504; stalled, no answer or a body that stopped;
  // offline, the browser says so, or every fetch failed and no status was seen; server, anything
  // else. `retryAt` (on the Overpass._now clock) is set only when every endpoint is on hold, and
  // nothing is sent before it.
  function post(body) {
    const run = queue.then(() => tryEndpoints(body));
    queue = run.catch(() => {});
    return run;
  }

  const Overpass = {
    ENDPOINTS,
    setOrder(keys) {
      const known = keys.filter((k) => ENDPOINTS[k]);
      if (known.length) order = known;
    },
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
