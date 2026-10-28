// Compares Estimates with the figures BRouter reports for the same GeoJSON track.
// Shared by estimates.test.js (committed fixtures) and estimates-cache.test.js (local cache).
"use strict";

// BRouter profile -> time tolerance: foot time is held to 2 %, bikes get a wider band for the way
// speed limits BRouter applies, which are not on the phone
const TIME_TOLERANCE = { "hiking-mountain": 0.02, shortest: 0.02, trekking: 0.1, fastbike: 0.1 };
const DIST_TOLERANCE = 0.003;
// the committed fixtures fix the model's constants, so they are held far tighter than the cache
const FIXTURE_TIME_TOLERANCE = { "hiking-mountain": 0.002, shortest: 0.002, trekking: 0.01, fastbike: 0.01 };
const FIXTURE_DIST_TOLERANCE = 0.0001;
const ASCENT_TOLERANCE_M = 2;

// `brouter_<profile>_<alternative>`
function profileOf(feature) {
  const m = /^brouter_(.+)_\d+$/.exec(feature && feature.properties && feature.properties.name || "");
  return m ? m[1] : null;
}

function hasElevation(feature) {
  const c = feature && feature.geometry && feature.geometry.coordinates;
  return Array.isArray(c) && c.length >= 2 && c.every((p) => p.length >= 3 && Number.isFinite(p[2]));
}

// |got - want| as a percent of want (the plain difference when want is 0)
const pct = (got, want) => (want === 0 ? Math.abs(got - want) : (Math.abs(got - want) / want) * 100);

function compare(Estimates, feature, profile, opts) {
  const c = feature.geometry.coordinates;
  const p = feature.properties;
  const est = Estimates.estimate(c.map((q) => [q[0], q[1]]), profile, c.map((q) => q[2]), opts);
  const want = { distanceM: Number(p["track-length"]), ascentM: Number(p["filtered ascend"]), seconds: Number(p["total-time"]) };
  return {
    est,
    want,
    distPct: pct(est.distanceM, want.distanceM),
    ascentDiffM: Math.abs(est.ascentM - want.ascentM),
    timePct: pct(est.seconds, want.seconds),
  };
}

module.exports = { compare, profileOf, hasElevation, TIME_TOLERANCE, DIST_TOLERANCE, FIXTURE_TIME_TOLERANCE, FIXTURE_DIST_TOLERANCE, ASCENT_TOLERANCE_M };
