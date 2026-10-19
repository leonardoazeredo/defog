// Elevation: terrain tiles by area, cached, interpolated; fake fetch and decoder, no network.
//   node bench/elevation.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { TileStore, Elevation } = global;

const Z = 12;
const N = 2 ** Z;

// inverse Web Mercator, written from the formulas and not from tileOf, so the two check each other
function lonLatAt(x, y, px, py) {
  const lon = ((x + px / 256) / N) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / 256)) / N))) * 180) / Math.PI;
  return [lon, lat];
}

// terrarium bytes for a height in metres, then the module's own decoder must give it back
function encode(h) {
  const v = h + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v - r * 256);
  const b = Math.round((v - r * 256 - g) * 256);
  return [r, g, b];
}
// the plane tilts both ways, so a swapped x/y weight or row cannot pass
const pixelHeight = (col, row) => 100 + col * 0.5 + row * 0.25;
const atPoint = (px, py) => pixelHeight(px - 0.5, py - 0.5); // exact for a linear plane away from the edges
function planeTile() {
  const data = new Uint8ClampedArray(256 * 256 * 4);
  for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
    const [r, g, b] = encode(pixelHeight(px, py));
    data.set([r, g, b, 255], (py * 256 + px) * 4);
  }
  return { width: 256, height: 256, data };
}

function fakes({ failing = new Set(), delay = false } = {}) {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const fetchTile = async (z, x, y) => {
    const key = `${z}/${x}/${y}`;
    calls.push(key);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    if (delay) await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (failing.has(key)) throw new Error("offline");
    return new Uint8Array([x & 255, y & 255]); // stands in for the PNG bytes
  };
  const decodeTile = async () => planeTile();
  return { fetchTile, decodeTile, calls, maxInFlight: () => maxInFlight };
}

(async () => {
  { // decodeHeight round-trips the extremes of the encoding
    for (const h of [0, -32768, 8848.5, 35.25, -418.5]) {
      const [r, g, b] = encode(h);
      assert.equal(Elevation.decodeHeight(r, g, b), h);
    }
    assert.equal(Elevation.decodeHeight(128, 0, 0), 0);
  }

  { // tileOf: the origin sits on the corner of tile 2048/2048; the other two were worked out with the Mercator formulas
    const o = Elevation.tileOf(0, 0, Z);
    assert.deepEqual([o.x, o.y, o.px, o.py], [2048, 2048, 0, 0]);
    const a = Elevation.tileOf(13.7, 51.0, Z);
    assert.deepEqual([a.x, a.y], [2203, 1371]);
    assert.ok(Math.abs(a.px - 224.1422) < 1e-3 && Math.abs(a.py - 63.6707) < 1e-3, `${a.px} ${a.py}`);
    const b = Elevation.tileOf(13.4, 52.5, Z);
    assert.deepEqual([b.x, b.y], [2200, 1343]);
    assert.ok(Math.abs(b.px - 118.3289) < 1e-3 && Math.abs(b.py - 173.6255) < 1e-3, `${b.px} ${b.py}`);
  }

  { // a point between two pixel centres gets their mean; a point on a centre gets that pixel
    const f = fakes();
    const el = Elevation.create({ store: TileStore.memory(), ...f });
    const [between, onCentre] = await el.elevationAt([lonLatAt(2203, 1371, 10, 100), lonLatAt(2203, 1371, 20.5, 100.5)]);
    assert.ok(Math.abs(between - (pixelHeight(9, 99) + pixelHeight(10, 99) + pixelHeight(9, 100) + pixelHeight(10, 100)) / 4) < 1e-6, String(between));
    assert.ok(Math.abs(between - atPoint(10, 100)) < 1e-6);
    assert.ok(Math.abs(onCentre - pixelHeight(20, 100)) < 1e-6, String(onCentre));
  }

  { // the tile edge clamps instead of reading a neighbour
    const f = fakes();
    const el = Elevation.create({ store: TileStore.memory(), ...f });
    const [left, right, top, bottom] = await el.elevationAt([
      lonLatAt(2203, 1371, 0.1, 50.5), lonLatAt(2203, 1371, 255.9, 50.5),
      lonLatAt(2203, 1371, 30.5, 0.1), lonLatAt(2203, 1371, 30.5, 255.9)
    ]);
    assert.ok(Math.abs(left - pixelHeight(0, 50)) < 1e-6);
    assert.ok(Math.abs(right - pixelHeight(255, 50)) < 1e-6);
    assert.ok(Math.abs(top - pixelHeight(30, 0)) < 1e-6);
    assert.ok(Math.abs(bottom - pixelHeight(30, 255)) < 1e-6);
    assert.deepEqual(f.calls, ["12/2203/1371"]);
  }

  { // two points in one tile cost one fetch; a second call for that tile costs none
    const f = fakes();
    const el = Elevation.create({ store: TileStore.memory(), ...f });
    const pts = [lonLatAt(2203, 1371, 30, 30), lonLatAt(2203, 1371, 90, 200)];
    const first = await el.elevationAt(pts);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(await el.elevationAt(pts), first);
    assert.equal(f.calls.length, 1);
  }

  { // the store, not only memory in the module, keeps tiles: a second instance on the same store fetches nothing
    const f = fakes();
    const store = TileStore.memory({ maxEntries: 200 });
    const pt = [lonLatAt(2203, 1371, 30, 30)];
    await Elevation.create({ store, ...f }).elevationAt(pt);
    await Elevation.create({ store, ...f }).elevationAt(pt);
    assert.equal(f.calls.length, 1);
  }

  { // a tile whose fetch rejects gives null for its points only, and is tried again next time
    const f = fakes({ failing: new Set(["12/2204/1371"]) });
    const el = Elevation.create({ store: TileStore.memory(), ...f });
    const pts = [lonLatAt(2203, 1371, 30, 30), lonLatAt(2204, 1371, 30, 30), lonLatAt(2203, 1371, 60, 60)];
    const out = await el.elevationAt(pts);
    assert.equal(typeof out[0], "number");
    assert.equal(out[1], null);
    assert.equal(typeof out[2], "number");
    await el.elevationAt(pts);
    assert.equal(f.calls.filter((c) => c === "12/2204/1371").length, 2);
  }

  { // a decoder that rejects, a store that throws, and points that are not on the map all give null or the network answer, never a throw
    const f = fakes();
    const brokenDecode = Elevation.create({ store: TileStore.memory(), fetchTile: f.fetchTile, decodeTile: async () => { throw new Error("bad png"); } });
    assert.deepEqual(await brokenDecode.elevationAt([lonLatAt(2203, 1371, 30, 30)]), [null]);

    const brokenStore = { get: async () => { throw new Error("idb"); }, put: async () => { throw new Error("idb"); }, delete: async () => {}, keys: async () => [] };
    const viaNetwork = await Elevation.create({ store: brokenStore, ...f }).elevationAt([lonLatAt(2203, 1371, 30, 30)]);
    assert.equal(typeof viaNetwork[0], "number");

    assert.deepEqual(await Elevation.create({ store: TileStore.memory(), ...f }).elevationAt(undefined), []);
    const before = f.calls.length;
    const odd = await Elevation.create({ store: TileStore.memory(), ...f }).elevationAt([[NaN, 10], [10, 89], [200, 10], [10, -89.9]]);
    assert.deepEqual(odd, [null, null, null, null]);
    assert.equal(f.calls.length, before, "points outside the map are not requested");
  }

  { // tiles are fetched at most four at a time
    const f = fakes({ delay: true });
    const el = Elevation.create({ store: TileStore.memory(), ...f });
    const pts = [];
    for (let i = 0; i < 9; i++) pts.push(lonLatAt(2100 + i, 1371, 30, 30));
    const out = await el.elevationAt(pts);
    assert.equal(f.calls.length, 9);
    assert.ok(f.maxInFlight() <= 4 && f.maxInFlight() > 1, `max in flight ${f.maxInFlight()}`);
    assert.ok(out.every((v) => typeof v === "number"));
  }

  { // cached bytes that fail to decode are dropped and the tile is fetched again; a failed decode of fresh bytes caches nothing
    const f = fakes();
    const store = TileStore.memory();
    await store.put("12/2203/1371", new Uint8Array([9, 9]));
    const decodeTile = async (bytes) => { if (bytes[0] === 9) throw new Error("garbage"); return planeTile(); };
    const el = Elevation.create({ store, fetchTile: f.fetchTile, decodeTile });
    const out = await el.elevationAt([lonLatAt(2203, 1371, 30, 30)]);
    assert.equal(typeof out[0], "number");
    assert.equal(f.calls.length, 1);
    assert.deepEqual([...(await store.get("12/2203/1371"))], [2203 & 255, 1371 & 255]);

    const empty = TileStore.memory();
    const bad = Elevation.create({ store: empty, fetchTile: f.fetchTile, decodeTile: async () => { throw new Error("bad png"); } });
    assert.deepEqual(await bad.elevationAt([lonLatAt(2204, 1371, 30, 30)]), [null]);
    assert.deepEqual(await empty.keys(), []);
  }

  { // two calls at once for one tile share a single fetch, and a tile evicted from the decoded set comes back from the store
    const f = fakes({ delay: true });
    const el = Elevation.create({ store: TileStore.memory(), ...f });
    const pt = [lonLatAt(2203, 1371, 30, 30)];
    await Promise.all([el.elevationAt(pt), el.elevationAt(pt)]);
    assert.equal(f.calls.length, 1);
    const many = [];
    for (let i = 0; i < 9; i++) many.push(lonLatAt(2100 + i, 1371, 30, 30));
    await el.elevationAt(many);
    const before = f.calls.length;
    await el.elevationAt(pt);
    assert.equal(f.calls.length, before, "the evicted tile is read from the store, not refetched");
  }

  { // a failure says why once per reason, without a position
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(" "));
    try {
      const f = fakes({ failing: new Set(["12/2203/1371", "12/2204/1371"]) });
      const el = Elevation.create({ store: TileStore.memory(), ...f });
      await el.elevationAt([lonLatAt(2203, 1371, 30, 30), lonLatAt(2204, 1371, 30, 30)]);
      await el.elevationAt([lonLatAt(2203, 1371, 30, 30)]);
    } finally { console.warn = realWarn; }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /offline/);
    assert.doesNotMatch(warnings[0], /2203|1371|13\.|51\./);
  }

  { // the default fetch asks for the terrarium tile of the bucket's own host, with no body, headers or credentials
    const seen = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => { seen.push([String(url), init]); return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
    try {
      const f = fakes();
      await Elevation.create({ store: TileStore.memory(), decodeTile: f.decodeTile }).elevationAt([lonLatAt(2203, 1371, 30, 30)]);
    } finally { global.fetch = realFetch; }
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/12/2203/1371.png");
    assert.deepEqual(Object.keys(seen[0][1] || {}), ["signal"], "only an abort signal rides along: no body, headers or credentials");
  }

  { // a failed response (404, 5xx) counts as a fetch failure
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 404 });
    try {
      const f = fakes();
      const out = await Elevation.create({ store: TileStore.memory(), decodeTile: f.decodeTile }).elevationAt([lonLatAt(2203, 1371, 30, 30)]);
      assert.deepEqual(out, [null]);
    } finally { global.fetch = realFetch; }
  }

  { // open() falls back to a memory store where IndexedDB is missing, like the street cache
    const el = await Elevation.open({ ...fakes() });
    assert.equal(typeof (await el.elevationAt([lonLatAt(2203, 1371, 30, 30)]))[0], "number");
  }

  console.log("elevation.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
