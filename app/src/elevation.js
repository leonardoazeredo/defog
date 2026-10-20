// Ground height from the AWS Open Data terrain tiles (terrarium PNG encoding), fetched by tile and
// kept in a TileStore. Only the tile coordinates leave the page; see README "Privacy".
(function (global) {
  const ZOOM = 12; // ~38 m a pixel at the equator; the finest sources are SRTM and 3DEP, coarser GMTED2010 fills other areas
  const TILE = 256;
  const MAX_IN_FLIGHT = 4;
  const FETCH_TIMEOUT_MS = 30000;
  const MAX_DECODED = 8; // caps decoded pixels at about 2 MB (256 KB each); an evicted tile is read from the store again, or refetched when the store lost it
  const BASE = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium";

  function decodeHeight(r, g, b) { return r * 256 + g + b / 256 - 32768; }

  // Web Mercator; px/py are fractional pixels inside the tile (pixel i covers [i, i+1))
  function tileOf(lon, lat, z) {
    const n = 2 ** z;
    const fx = ((lon + 180) / 360) * n;
    const fy = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
    const x = Math.floor(fx), y = Math.floor(fy);
    return { x, y, px: (fx - x) * TILE, py: (fy - y) * TILE };
  }

  async function defaultFetchTile(z, x, y) {
    // a stalled connection would otherwise hold elevationAt, and every later call for the tile, forever
    const ctl = new global.AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await global.fetch(`${BASE}/${z}/${x}/${y}.png`, { signal: ctl.signal });
      if (!res.ok) throw new Error("elevation tile " + res.status);
      return new Uint8Array(await res.arrayBuffer());
    } finally { clearTimeout(timer); }
  }

  // no colour conversion or premultiplying, so the bytes read back are the bytes encoded
  async function defaultDecodeTile(bytes) {
    const bmp = await global.createImageBitmap(new Blob([bytes], { type: "image/png" }), {
      premultiplyAlpha: "none", colorSpaceConversion: "none"
    });
    try {
      const canvas = new global.OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const { width, height, data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      return { width, height, data };
    } finally { bmp.close(); }
  }

  function create(opts) {
    const o = opts || {};
    const store = o.store || global.TileStore.memory({ maxEntries: 200 });
    const fetchTile = o.fetchTile || defaultFetchTile;
    const decodeTile = o.decodeTile || defaultDecodeTile;
    const decoded = new Map(); // key -> Promise<image|null>, oldest first
    const warned = new Set();

    // null alone cannot tell offline from a blocked host or a broken decoder; one line per distinct
    // reason says which. It logs the error's own message, never the tile or point; browsers' fetch
    // errors do not carry the URL, so if that ever changes, filter it here
    function warnOnce(e) {
      const reason = (e && e.name) + ": " + (e && e.message);
      if (warned.has(reason)) return;
      warned.add(reason);
      console.warn("elevation tile not loaded, " + reason);
    }

    // resolves to the decoded tile, or null when it can be neither read nor fetched
    async function loadTile(z, x, y) {
      const key = `${z}/${x}/${y}`;
      let bytes;
      try { bytes = await store.get(key); } catch (e) { bytes = undefined; }
      if (bytes) {
        try { return await decodeTile(bytes); } catch (e) {
          // a cached copy that fails to decode would fail on every call until it is dropped
          try { await store.delete(key); } catch (e2) { /* nothing more to do */ }
        }
      }
      try {
        bytes = await fetchTile(z, x, y);
        const image = await decodeTile(bytes);
        try { await store.put(key, bytes); } catch (e) { /* a full or broken store only costs a refetch */ }
        return image;
      } catch (e) {
        warnOnce(e);
        return null;
      }
    }

    function tile(z, x, y) {
      const key = `${z}/${x}/${y}`;
      let p = decoded.get(key);
      if (p) { decoded.delete(key); decoded.set(key, p); return p; }
      p = loadTile(z, x, y);
      // a miss is not kept: the next call tries the network again
      p.then((img) => { if (!img && decoded.get(key) === p) decoded.delete(key); });
      decoded.set(key, p);
      while (decoded.size > MAX_DECODED) decoded.delete(decoded.keys().next().value);
      return p;
    }

    // bilinear between the four nearest pixel centres; at a tile edge the edge pixel stands in
    // for the neighbour, which is under half a pixel of error
    function sample(img, px, py) {
      const fx = px - 0.5, fy = py - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const cl = (v, max) => Math.min(Math.max(v, 0), max - 1);
      const h = (x, y) => {
        const i = (cl(y, img.height) * img.width + cl(x, img.width)) * 4;
        return decodeHeight(img.data[i], img.data[i + 1], img.data[i + 2]);
      };
      const top = h(x0, y0) * (1 - tx) + h(x0 + 1, y0) * tx;
      const bottom = h(x0, y0 + 1) * (1 - tx) + h(x0 + 1, y0 + 1) * tx;
      const height = top * (1 - ty) + bottom * ty;
      return Number.isFinite(height) ? height : null;
    }

    async function elevationAt(points) {
      if (!Array.isArray(points)) return [];
      const out = new Array(points.length).fill(null);
      const byTile = new Map(); // key -> {x, y, items: [{i, px, py}]}
      const n = 2 ** ZOOM;
      points.forEach((pt, i) => {
        const lon = pt && pt[0], lat = pt && pt[1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        const t = tileOf(lon, lat, ZOOM);
        if (t.x < 0 || t.x >= n || t.y < 0 || t.y >= n) return; // off the map: nothing to ask for
        const key = t.x + "/" + t.y;
        if (!byTile.has(key)) byTile.set(key, { x: t.x, y: t.y, items: [] });
        byTile.get(key).items.push({ i, px: t.px, py: t.py });
      });
      const queue = [...byTile.values()];
      const worker = async () => {
        for (let t = queue.shift(); t; t = queue.shift()) {
          const img = await tile(ZOOM, t.x, t.y);
          if (img) for (const it of t.items) out[it.i] = sample(img, it.px, it.py);
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, queue.length) }, worker));
      return out;
    }

    return { elevationAt };
  }

  // the page's own instance: tiles kept in IndexedDB, memory when that is unavailable
  async function open(opts) {
    const store = await global.TileStore.open("crossfog-elevation", "tiles", { maxEntries: 200 });
    return create({ ...opts, store });
  }

  global.Elevation = { create, open, tileOf, decodeHeight };
})(window);
