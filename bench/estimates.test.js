// Estimates: BRouter's distance, filtered ascent and time model, checked against BRouter's own
// figures for the committed responses in bench/fixtures/brouter/.
//   node bench/estimates.test.js
"use strict";
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
require("./lib/load.js");
const { Estimates } = global;
const { compare, profileOf, hasElevation, FIXTURE_TIME_TOLERANCE, FIXTURE_DIST_TOLERANCE, ASCENT_TOLERANCE_M } = require("./lib/brouterCheck.js");

const DIR = path.join(__dirname, "fixtures", "brouter");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
assert.ok(files.length >= 9, "fixtures present");

const worst = { distPct: 0, ascentDiffM: 0, footTimePct: 0, bikeTimePct: 0 };
const ascentMatches = { 10: 0, 5: 0 };
let checked = 0;

for (const f of files) {
  const feature = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")).features[0];
  const profile = profileOf(feature);
  assert.ok(profile, `${f}: profile in the track name`);
  assert.ok(hasElevation(feature), `${f}: elevations in the fixture`);

  const r = compare(Estimates, feature, profile);
  assert.ok(r.distPct <= FIXTURE_DIST_TOLERANCE * 100, `${f}: distance ${r.est.distanceM} vs ${r.want.distanceM}`);
  const tol = FIXTURE_TIME_TOLERANCE[profile];
  assert.ok(r.timePct <= tol * 100, `${f}: time ${r.est.seconds} vs ${r.want.seconds}`);

  // BRouter filters with 5 m where its own elevation data is 1 arc second and with 10 m elsewhere,
  // node by node, so one constant cannot match every track: the fixture must match one of the two
  // and BRouter's figure must lie between them
  const hi = r.est.ascentM;
  const lo = compare(Estimates, feature, profile, { ascentFilterM: 5 }).est.ascentM;
  for (const [m, got] of [[10, hi], [5, lo]]) if (Math.abs(got - r.want.ascentM) <= ASCENT_TOLERANCE_M) ascentMatches[m]++;
  assert.ok(Math.abs(hi - r.want.ascentM) <= ASCENT_TOLERANCE_M || Math.abs(lo - r.want.ascentM) <= ASCENT_TOLERANCE_M,
    `${f}: ascent ${hi} (10 m) or ${lo} (5 m) vs ${r.want.ascentM}`);
  assert.ok(r.want.ascentM >= hi - ASCENT_TOLERANCE_M && r.want.ascentM <= lo + ASCENT_TOLERANCE_M, `${f}: BRouter ascent between the two filters`);
  worst.distPct = Math.max(worst.distPct, r.distPct);
  worst.ascentDiffM = Math.max(worst.ascentDiffM, r.ascentDiffM);
  const key = Estimates.MODES[profile].kind === "foot" ? "footTimePct" : "bikeTimePct";
  worst[key] = Math.max(worst[key], r.timePct);
  checked++;
}
assert.equal(checked, files.length);

// the 10 m default misses at most one fixture (hyde-park-fastbike); 5 m fits more local
// cache answers within 2 m but has twice the mean error there (estimates-cache.test.js prints both)
assert.ok(ascentMatches[10] >= files.length - 1, `10 m filter matches ${ascentMatches[10]} of ${files.length}`);

// distance: the cheap ruler on a meridian
{
  const d = Estimates.distanceM([13.4, 52.0], [13.4, 52.0 + 1000 / 111_200]);
  assert.ok(Math.abs(d - 1000) <= 1, `1 km on a meridian: ${d}`);
  assert.equal(Estimates.distanceM([13.4, 52.5], [13.4, 52.5]), 1, "a link is never shorter than 1 m");
}

// a missing elevation tile degrades to a flat section, never a throw
{
  const coords = [[13.4, 52.5], [13.401, 52.5], [13.402, 52.5], [13.403, 52.5]];
  const r = Estimates.estimate(coords, "hiking-mountain", [null, 40, null, 42]);
  assert.ok(Number.isFinite(r.seconds) && r.seconds > 0);
  assert.deepEqual(r.coords.map((c) => c[2]), [40, 40, 40, 42], "leading null takes the first known value, later nulls carry forward");
  assert.equal(r.ascentM, 2);
  assert.equal(r.elevationKnown, 2, "the result says how many heights were real");
  const none = Estimates.estimate(coords, "trekking", [null, null, null, null]);
  assert.deepEqual(none.coords.map((c) => c[2]), [0, 0, 0, 0], "all null is flat at 0");
  assert.equal(none.ascentM, 0);
  assert.equal(none.elevationKnown, 0);
  assert.equal(none.descentM, 0);
}

// ascent and descent are mirror images, so they differ by the net height change (up to the filter's buffer)
{
  const coords = Array.from({ length: 41 }, (_, i) => [13.4 + i * 0.0005, 52.5]);
  const z = coords.map((_, i) => 100 + 30 * Math.sin(i / 4));
  const r = Estimates.estimate(coords, "trekking", z);
  assert.ok(r.ascentM > 0 && r.descentM > 0);
  assert.ok(Math.abs(r.ascentM - r.descentM - (z[z.length - 1] - z[0])) <= 10, "ascent - descent = net change within the buffer");
}

// a wobble refills the buffer instead of counting again: up 3, down 3, up 3, down 3 is one 3 m climb; a steady climb counts fully
{
  const coords = [0, 1, 2, 3, 4].map((i) => [13.4 + i * 0.0005, 52.5]);
  const wobble = Estimates.estimate(coords, "hiking-mountain", [0, 3, 0, 3, 0]);
  assert.equal(wobble.ascentM, 3);
  assert.equal(wobble.descentM, 0, "the first 3 m descent is held in the buffer and the next rise cancels it");
  assert.equal(Estimates.estimate(coords, "hiking-mountain", [0, 6, 12, 18, 24]).ascentM, 24);
  // the 20 m of drop beyond the filter is forgotten, so only 20 of the 30 m climb back counts
  assert.equal(Estimates.estimate(coords, "hiking-mountain", [30, 0, 0, 0, 30]).ascentM, 20, "buffer saturates at -10: 30 m back up counts 20 m");
}

// uphill is slower than flat
{
  const coords = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => [13.4 + i * 0.0005, 52.5]);
  const flat = Estimates.estimate(coords, "hiking-mountain", coords.map(() => 50)).seconds;
  const up = Estimates.estimate(coords, "hiking-mountain", coords.map((_, i) => 50 + i * 4)).seconds;
  assert.ok(up > flat * 1.2, `uphill ${up} vs flat ${flat}`);
  const flatBike = Estimates.estimate(coords, "fastbike", coords.map(() => 50)).seconds;
  const upBike = Estimates.estimate(coords, "fastbike", coords.map((_, i) => 50 + i * 4)).seconds;
  assert.ok(upBike > flatBike * 1.5, `uphill ${upBike} vs flat ${flatBike}`);
}

// car: a constant speed; a mode with no model still gets distance and heights, no time
{
  const coords = [[13.4, 52.5], [13.41, 52.5]];
  const car = Estimates.estimate(coords, "car-fast", [10, 10]);
  assert.ok(Math.abs(car.seconds - car.distanceM / (45 / 3.6)) <= 1);
  const unmodelled = Estimates.estimate(coords, "hovercraft", [10, 12]);
  assert.equal(unmodelled.seconds, null);
  assert.ok(unmodelled.distanceM > 600);
  assert.equal(unmodelled.ascentM, 2);
}

// degenerate input
{
  assert.throws(() => Estimates.estimate([[13.4, 52.5], [NaN, 52.5]], "trekking", [1, 2]), TypeError);
  assert.throws(() => Estimates.estimate([[13.4, 52.5], null], "trekking", [1, 2]), TypeError);
  assert.equal(Estimates.estimate([[13.4, 52.5], [13.41, 52.5]], "toString", [1, 2]).seconds, null, "inherited names are not modes");
  const one = Estimates.estimate([[13.4, 52.5]], "trekking", [10]);
  assert.deepEqual([one.distanceM, one.seconds, one.ascentM, one.descentM], [0, 0, 0, 0]);
  assert.deepEqual(Estimates.estimate([], "trekking", []).coords, []);
}

console.log(`largest deviations over ${checked} fixtures: distance ${worst.distPct.toFixed(3)} %, ascent ${worst.ascentDiffM} m, foot time ${worst.footTimePct.toFixed(2)} %, bike time ${worst.bikeTimePct.toFixed(2)} %`);
console.log(`ascent filter: 10 m matches ${ascentMatches[10]}/${checked}, 5 m matches ${ascentMatches[5]}/${checked}`);
console.log("estimates.test.js ok");
