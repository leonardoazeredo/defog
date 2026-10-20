// Reveal: cells revealed by a track under the versioned rules; synthetic tracks, no Sync/.
//   node bench/reveal.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { lngLatToCell, cellToLngLat, WORLD_CELLS } = global.FogParser;
const { Reveal } = global;

const R = 6378137; // the sphere the grid is drawn on
const RAD = Math.PI / 180;
const M_PER_DEG = R * RAD;
const H = Reveal.RULES.halfWidthM;
const cellOf = (lon, lat) => { const c = lngLatToCell(lon, lat); return [Math.floor(c.cx), Math.floor(c.cy)]; };
const key = (c) => c[0] + "," + c[1];
const toSet = (arr) => { const s = new Set(); for (let i = 0; i < arr.length; i += 2) s.add(arr[i] + "," + arr[i + 1]); return s; };
const lonShift = (lat, m) => m / (M_PER_DEG * Math.cos(lat * RAD));
const latShift = (m) => m / M_PER_DEG;
const track = (pts, dtMs = 5000, accuracy) => pts.map(([lon, lat], i) => ({ t: 1e12 + i * dtMs, lat, lon, accuracy }));

// independent oracle: every cell in a box whose centre is within h metres of the segment, flat frame at lat0
function oracle(a, b, lat0, h, pad) {
  const kx = M_PER_DEG * Math.cos(lat0 * RAD), ky = M_PER_DEG;
  const A = [a[0] * kx, a[1] * ky], B = [b[0] * kx, b[1] * ky];
  const ca = cellOf(...a), cb = cellOf(...b);
  const out = new Set();
  for (let cx = Math.min(ca[0], cb[0]) - pad; cx <= Math.max(ca[0], cb[0]) + pad; cx++) {
    for (let cy = Math.min(ca[1], cb[1]) - pad; cy <= Math.max(ca[1], cb[1]) + pad; cy++) {
      const c = cellToLngLat(cx + 0.5, cy + 0.5);
      const P = [c.lng * kx, c.lat * ky];
      const dx = B[0] - A[0], dy = B[1] - A[1], len2 = dx * dx + dy * dy;
      const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len2));
      if (Math.hypot(P[0] - A[0] - u * dx, P[1] - A[1] - u * dy) <= h) out.add(cx + "," + cy);
    }
  }
  return out;
}

// RULES
{
  assert.deepEqual({ ...Reveal.RULES }, { version: 1, maxAccuracyM: 50, maxGapS: 60, maxGapM: 150, halfWidthM: 12 });
  assert.ok(Object.isFrozen(Reveal.RULES));
}

// a straight 100 m east-west line at 48.0 N, a point every 5 s
{
  const lat = 48, lon0 = 11;
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push([lon0 + lonShift(lat, i * 5), lat]);
  const got = toSet(Reveal.reveal(track(pts), Reveal.RULES));
  const want = oracle(pts[0], pts[20], lat, H, 8);
  // the swath is 24 m wide and about 124 m long; a 6.4 m cell at 48 N puts 3 or 4 centres across and 19 or 20 along
  assert.ok(want.size >= 57 && want.size <= 80);
  assert.deepEqual([...got].sort(), [...want].sort());
  // one cell on the line, in the middle: its centre is at most half a cell (3.2 m) off the line
  assert.ok(got.has(key(cellOf(lon0 + lonShift(lat, 50), lat))));
  // the cell 20 m north of the line: its centre is 16.8-23.2 m away
  assert.ok(!got.has(key(cellOf(lon0 + lonShift(lat, 50), lat + latShift(20)))));
  assert.ok(!got.has(key(cellOf(lon0 + lonShift(lat, 50), lat - latShift(20)))));
  // 30 m past the east end: nothing
  assert.ok(!got.has(key(cellOf(lon0 + lonShift(lat, 130), lat))));
  // the cell holding the point 9 m north of the line has its centre 6.6 m off the line, inside 12 m, so the swath is wider than one cell row
  assert.ok(got.has(key(cellOf(lon0 + lonShift(lat, 50), lat + latShift(9)))));
}

// point order inside a segment does not change the answer
{
  const lat = 48, lon0 = 11;
  const a = [lon0, lat], b = [lon0 + lonShift(lat, 100), lat + latShift(40)];
  assert.deepEqual(Reveal.reveal(track([a, b])), Reveal.reveal(track([b, a])));
}

// a gap reveals nothing between ends further apart than 2 * halfWidthM; both ends still reveal
{
  const lat = 48, lon0 = 11;
  const a = [lon0, lat], b = [lon0 + lonShift(lat, 100), lat];
  const mid = cellOf(lon0 + lonShift(lat, 50), lat);
  for (const [name, pts] of [
    ["120 s", track([a, b], 120000)],
    ["60.001 s", track([a, b], 60001)],
    ["distance", track([[lon0, lat], [lon0 + lonShift(lat, 151), lat]], 5000)],
  ]) {
    const got = toSet(Reveal.reveal(pts));
    const far = pts[1].lon;
    assert.ok(got.has(key(cellOf(pts[0].lon, lat))), name + " start");
    assert.ok(got.has(key(cellOf(far, lat))), name + " end");
    const midOfPair = cellOf((pts[0].lon + far) / 2, lat);
    assert.ok(!got.has(key(midOfPair)), name + " midpoint");
  }
  // closer than 2 * halfWidthM the two discs meet, so the midpoint of a short gap is revealed
  const near = [[lon0, lat], [lon0 + lonShift(lat, 5), lat]];
  assert.ok(toSet(Reveal.reveal(track(near, 120000))).has(key(cellOf(lon0 + lonShift(lat, 2.5), lat))));
  // the limits themselves join
  assert.ok(toSet(Reveal.reveal(track([a, b], 60000))).has(key(mid)));
  const c = [lon0 + lonShift(lat, 148), lat];
  assert.ok(toSet(Reveal.reveal(track([a, c], 5000))).has(key(cellOf((a[0] + c[0]) / 2, lat))));
  // a gap in the middle of a longer track splits it into two runs
  const p = [0, 50, 100, 400, 450, 500].map((m) => [lon0 + lonShift(lat, m), lat]);
  const t = track(p).map((q, i) => ({ ...q, t: 1e12 + i * 5000 + (i >= 3 ? 300000 : 0) }));
  const got = toSet(Reveal.reveal(t));
  assert.ok(got.has(key(cellOf(lon0 + lonShift(lat, 75), lat))));
  assert.ok(got.has(key(cellOf(lon0 + lonShift(lat, 425), lat))));
  assert.ok(!got.has(key(cellOf(lon0 + lonShift(lat, 250), lat))));
}

// a point with accuracy over the limit is dropped and does not join its neighbours
{
  const lat = 48, lon0 = 11;
  const p = [0, 40, 80].map((m) => [lon0 + lonShift(lat, m), lat]);
  // the outer points are 80 m apart in 10 s, so they join; the dropped point sits 60 m off that line to tell the cases apart
  const off = [lon0 + lonShift(lat, 40), lat + latShift(60)];
  const t2 = track([p[0], off, p[2]]);
  t2[1].accuracy = 80.5;
  const got2 = toSet(Reveal.reveal(t2));
  assert.ok(!got2.has(key(cellOf(...off))));
  assert.ok(!got2.has(key(cellOf(off[0], lat + latShift(30)))));
  assert.ok(got2.has(key(cellOf(lon0 + lonShift(lat, 40), lat))));
  assert.deepEqual([...got2].sort(), [...toSet(Reveal.reveal(track([p[0], p[2]], 10000)))].sort());
  // accuracy at the limit and a missing accuracy keep the point
  const kept = track([p[0], off, p[2]]);
  kept[1].accuracy = 50;
  assert.ok(toSet(Reveal.reveal(kept)).has(key(cellOf(...off))));
  kept[1].accuracy = undefined;
  assert.ok(toSet(Reveal.reveal(kept)).has(key(cellOf(...off))));
  // the kept neighbours are 80 s apart, longer than maxGapS, so they do not join and the dropped point does not bridge them
  const wide = track([p[0], off, p[2]], 40000);
  wide[1].accuracy = 80;
  assert.ok(!toSet(Reveal.reveal(wide)).has(key(cellOf(lon0 + lonShift(lat, 40), lat))), "80 s between the kept points is a gap");
}

// a single kept point reveals a disc
{
  const lat = 48, lon0 = 11;
  const got = toSet(Reveal.reveal(track([[lon0, lat]])));
  const want = oracle([lon0, lat], [lon0, lat], lat, H, 6);
  assert.deepEqual([...got].sort(), [...want].sort());
  assert.ok(got.has(key(cellOf(lon0, lat))));
  assert.ok(!got.has(key(cellOf(lon0 + lonShift(lat, 20), lat))));
  assert.ok(!got.has(key(cellOf(lon0, lat + latShift(20)))));
}

// an isolated point between two gaps still reveals
{
  const lat = 48, lon0 = 11;
  const t = track([[lon0, lat], [lon0 + lonShift(lat, 300), lat], [lon0 + lonShift(lat, 600), lat]]);
  const got = toSet(Reveal.reveal(t));
  assert.ok(got.has(key(cellOf(lon0 + lonShift(lat, 300), lat))));
}

// other hemispheres: cells match lngLatToCell of the points
for (const [lon, lat] of [[151.2, -33.9], [-74.0, 40.7], [-151.2, -33.9], [0.0001, 0.0001]]) {
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push([lon + lonShift(lat, i * 10), lat + latShift(i * 3)]);
  const got = toSet(Reveal.reveal(track(pts)));
  for (const p of pts) assert.ok(got.has(key(cellOf(...p))), `${lon},${lat}`);
  const want = new Set();
  for (let i = 0; i < pts.length - 1; i++) for (const k of oracle(pts[i], pts[i + 1], (pts[i][1] + pts[i + 1][1]) / 2, H, 8)) want.add(k);
  assert.deepEqual([...got].sort(), [...want].sort(), `${lon},${lat}`);
}

// crossing the antimeridian is a gap; the ends still reveal, and the disc wraps around the world edge
{
  const t = track([[179.9999, 0], [-179.9999, 0]]);
  const got = toSet(Reveal.reveal(t));
  assert.ok(got.has(key(cellOf(179.9999, 0))));
  assert.ok(got.has(key(cellOf(-179.9999, 0))));
  // the ends are 22 m apart, under 2 * halfWidthM, so their discs meet across the seam; the gap rule itself is pinned by the maxGapM override below
  const seam = toSet(Reveal.reveal(track([[179.99995, 0]])));
  const row = cellOf(179.99995, 0)[1];
  // the cell west of the seam holds the point; cell 0 lies 10.3 m east of it across the seam, inside 12 m
  assert.ok(seam.has(WORLD_CELLS - 1 + "," + row));
  assert.ok(seam.has("0," + row));
  assert.ok(!seam.has("1," + row), "cell 1 is 19.9 m away");
  for (const k of seam) { const [x, y] = k.split(",").map(Number); assert.ok(x >= 0 && x < WORLD_CELLS && y >= 0 && y < WORLD_CELLS); }
  // the rule holds on its own, not only through the distance limit
  const loose = { ...Reveal.RULES, maxGapM: 1e9 };
  assert.ok(toSet(Reveal.reveal(track([[179.9999, 0], [-179.9999, 0]]), loose)).size < 2000);
  // 2 degrees apart across the seam but 358 apart in longitude: two discs, not a band round the world
  assert.ok(toSet(Reveal.reveal(track([[179, 10], [-179, 10]], 1000))).size < 2000);
  assert.ok(got.size < 2000);
}

// the poles: latitudes clamp, nothing throws, cells stay inside the grid
{
  for (const lat of [89, -89, 90, -90, 85.0511, 1000]) {
    const out = Reveal.reveal(track([[10, lat], [10.0001, lat]]));
    assert.ok(out.length > 0, String(lat));
    for (let i = 0; i < out.length; i += 2) {
      assert.ok(out[i] >= 0 && out[i] < WORLD_CELLS && out[i + 1] >= 0 && out[i + 1] < WORLD_CELLS, String(lat));
    }
  }
  // 89 reveals the same cells as 85.0511, the clamp
  assert.deepEqual(Reveal.reveal(track([[10, 89]])), Reveal.reveal(track([[10, 85.0511]])));
}

// deterministic, sorted, unique, Int32Array
{
  const lat = 48, lon0 = 11;
  const pts = [];
  for (let i = 0; i <= 30; i++) pts.push([lon0 + lonShift(lat, i * 8), lat + latShift(Math.sin(i) * 10)]);
  const t = track(pts);
  const a = Reveal.reveal(t), b = Reveal.reveal(t);
  assert.ok(a instanceof Int32Array);
  assert.equal(a.length % 2, 0);
  assert.deepEqual(a, b);
  // repeating the whole track (same cells again) changes nothing
  const twice = Reveal.reveal(t.concat(t.map((p) => ({ ...p, t: p.t + 1e9 }))));
  assert.deepEqual(twice, a);
  for (let i = 2; i < a.length; i += 2) {
    assert.ok(a[i] > a[i - 2] || (a[i] === a[i - 2] && a[i + 1] > a[i - 1]), "sorted by cx then cy, unique");
  }
}

// empty and degenerate input
{
  assert.equal(Reveal.reveal([]).length, 0);
  assert.equal(Reveal.reveal(track([[10, 10]], 5000, 500)).length, 0, "every point dropped");
  assert.equal(Reveal.reveal([{ t: 0, lat: NaN, lon: 10 }, { t: 1, lat: 10, lon: Infinity }, { t: NaN, lat: 1, lon: 1 }]).length, 0, "non-finite points are dropped");
  assert.throws(() => Reveal.reveal(track([[10, 10]]), { ...Reveal.RULES, halfWidthM: NaN }));
  assert.throws(() => Reveal.reveal(track([[10, 10]]), { ...Reveal.RULES, maxGapS: -1 }));
  // out-of-order times are a gap, not a segment
  const back = [{ t: 2e12, lat: 48, lon: 11 }, { t: 1e12, lat: 48, lon: 11 + lonShift(48, 50) }];
  assert.ok(!toSet(Reveal.reveal(back)).has(key(cellOf(11 + lonShift(48, 25), 48))));
}

console.log("reveal.test.js ok");
