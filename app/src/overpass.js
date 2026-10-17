// Overpass endpoints for the street data, shared by suggestions and the "Streets in fog" look so
// they obey one backoff. One request is in flight at a time. An endpoint that answers 429 or 406
// is left alone for at least 30 s, as the OSM forum's overpass-api.de thread asks
// (community.openstreetmap.org/t/overpass-api-performance-issues/140598/157): clients that keep
// running into 429 or 406 get banned sooner. private.coffee goes first: its page
// (overpass.private.coffee) states no rate limit.
(function (global) {
  const ENDPOINTS = {
    coffee: "https://overpass.private.coffee/api/interpreter",
    main: "https://overpass-api.de/api/interpreter"
  };
  const DEFAULT_ORDER = ["coffee", "main"];
  const MIN_BACKOFF_MS = 30000;

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
          body
        });
      } catch (e) {
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
    const err = lastError || new Error("overpass: every endpoint is rate-limited");
    const later = order.map((k) => blockedUntil[ENDPOINTS[k]] || 0).filter((at) => at > Overpass._now());
    if (later.length === order.length) err.retryAt = Math.min(...later);
    throw err;
  }

  // Resolves with the first endpoint's JSON. Rejects with the last error; its retryAt (on the
  // Overpass._now clock) is set only when every endpoint is blocked, and nothing is sent before it.
  // A 200 whose body is not JSON rejects without trying the next endpoint. There is no timeout:
  // the queries carry Overpass's own [timeout:60], after which the server answers.
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
    // test-only hooks, used between settled posts: a fake clock and a way back to the initial state
    _now: () => Date.now(),
    _reset() { order = DEFAULT_ORDER.slice(); blockedUntil = {}; queue = Promise.resolve(); Overpass._now = () => Date.now(); }
  };
  global.Overpass = Overpass;
})(window);
