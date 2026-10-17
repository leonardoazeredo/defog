// Overpass endpoints for the street data, shared by suggestions and the "Streets in fog" look so
// they obey one backoff. One request is in flight at a time. An endpoint that answers 429 or 406
// is left alone for at least 30 s, which the OSM forum's overpass-api.de thread asks; clients that
// keep running into 429 or 406 get banned sooner
// (community.openstreetmap.org/t/overpass-api-performance-issues/140598/157). A request that fails
// without a readable status (no network, a timeout, or an answer without CORS headers, which can
// hide a 429) gets the same hold.
// private.coffee goes first: its page (overpass.private.coffee) states no rate limit.
(function (global) {
  const ENDPOINTS = {
    coffee: "https://overpass.private.coffee/api/interpreter",
    main: "https://overpass-api.de/api/interpreter"
  };
  const DEFAULT_ORDER = ["coffee", "main"];
  const MIN_BACKOFF_MS = 30000;
  // A dead connection would otherwise hold the one-request queue indefinitely. overpass-api.de can
  // wait up to 15 s for a slot and 15 s for admission, the queries run at most [timeout:60], and
  // the rest is left for the download.
  const REQUEST_TIMEOUT_MS = 120000;

  let order = DEFAULT_ORDER.slice();
  let blockedUntil = {}; // url -> time before which it is not asked again
  let queue = Promise.resolve();

  // A browser exposes Retry-After to page script only if the server lists it in
  // Access-Control-Expose-Headers, and an HTTP-date value is not parsed: either way the 30 s floor
  // applies.
  function retryAfterMs(res) {
    const secs = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
    return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
  }

  async function tryEndpoints(body) {
    const now = Overpass._now();
    let lastError = null;
    for (const key of order) {
      const url = ENDPOINTS[key];
      if ((blockedUntil[url] || 0) > now) continue;
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          // UA is for the Node benchmark harness (Overpass rejects Node's default). Page script
          // cannot set it in a browser; in the app Overpass sees the WebView's UA, which
          // contains the "CrossTheFog/<version>" name WebShell.tsx adds.
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "FogToMaps/1.0 (defog route suggestions)" },
          body,
          signal: AbortSignal.timeout(Overpass._timeoutMs)
        });
      } catch (e) {
        blockedUntil[url] = Overpass._now() + MIN_BACKOFF_MS;
        lastError = e;
        continue;
      }
      if (res.status === 429 || res.status === 406) {
        blockedUntil[url] = Overpass._now() + Math.max(MIN_BACKOFF_MS, retryAfterMs(res));
        lastError = new Error("overpass HTTP " + res.status);
        continue;
      }
      if (!res.ok) {
        lastError = new Error("overpass HTTP " + res.status);
        continue;
      }
      return res.json();
    }
    const err = lastError || new Error("overpass: every endpoint is on hold");
    const later = order.map((k) => blockedUntil[ENDPOINTS[k]] || 0).filter((at) => at > Overpass._now());
    if (later.length === order.length) err.retryAt = Math.min(...later);
    throw err;
  }

  // Resolves with the first endpoint's JSON. Rejects with the last error; its retryAt (on the
  // Overpass._now clock) is set only when every endpoint is blocked, and nothing is sent before it.
  // A 200 whose body is not JSON, or whose body is still arriving when the timeout fires, rejects
  // without a hold and without trying the next endpoint.
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
    // test-only hooks, used between settled posts: a fake clock, a short timeout, and a way back to
    // the initial state
    _now: () => Date.now(),
    _timeoutMs: REQUEST_TIMEOUT_MS,
    _reset() {
      order = DEFAULT_ORDER.slice(); blockedUntil = {}; queue = Promise.resolve();
      Overpass._now = () => Date.now(); Overpass._timeoutMs = REQUEST_TIMEOUT_MS;
    }
  };
  global.Overpass = Overpass;
})(window);
