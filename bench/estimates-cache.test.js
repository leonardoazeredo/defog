// Estimates against every usable BRouter answer in the local bench/cache/brouter/ (gitignored, built
// from the owner's own areas); skips when it is absent (a missing directory named by CROSSFOG_BROUTER_CACHE fails). Prints figures only, never places.
//   node bench/estimates-cache.test.js              # or CROSSFOG_BROUTER_CACHE=<dir> to read another directory
"use strict";
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
require("./lib/load.js");
const { Estimates } = global;
const { compare, profileOf, hasElevation, TIME_TOLERANCE, DIST_TOLERANCE, ASCENT_TOLERANCE_M } = require("./lib/brouterCheck.js");

const DIR = process.env.CROSSFOG_BROUTER_CACHE || path.join(__dirname, "cache", "brouter");
if (!fs.existsSync(DIR) || !fs.statSync(DIR).isDirectory()) {
  // an explicit path that is wrong is a mistake, not an absent optional cache
  assert.ok(!process.env.CROSSFOG_BROUTER_CACHE, "CROSSFOG_BROUTER_CACHE is not a directory");
  console.log("estimates-cache.test.js ok (skipped: no cache)");
  process.exit(0);
}

// each file is {ok, status, body: <GeoJSON>}; the profile is only in the track name
const MAX_MEAN_ASCENT_ERR_M = 8;
const worst = {};
let used = 0;
let unusable = 0;
let wellMatched = 0;
let ascentErrSum = 0;
let loErrSum = 0;
let loMatched = 0;
for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith(".json")).sort()) {
  let feature;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    feature = j && j.ok && j.body && Array.isArray(j.body.features) ? j.body.features[0] : null;
  } catch (e) { feature = null; }
  const profile = feature && profileOf(feature);
  if (!feature || !profile || !Estimates.MODES[profile] || !hasElevation(feature)) { unusable++; continue; }

  const r = compare(Estimates, feature, profile);
  const lo = compare(Estimates, feature, profile, { ascentFilterM: 5 }).est.ascentM;
  assert.ok(r.distPct <= DIST_TOLERANCE * 100, `${profile}: distance ${r.est.distanceM} vs ${r.want.distanceM}`);
  const tol = TIME_TOLERANCE[profile];
  assert.ok(r.timePct <= tol * 100, `${profile}: time ${r.est.seconds} vs ${r.want.seconds}`);
  // the filter BRouter applies depends on its data per node, so its figure lies between the two constants
  assert.ok(r.want.ascentM >= r.est.ascentM - ASCENT_TOLERANCE_M && r.want.ascentM <= lo + ASCENT_TOLERANCE_M, `${profile}: ascent ${r.est.ascentM}..${lo} vs ${r.want.ascentM}`);

  const w = (worst[profile] ||= { n: 0, distPct: 0, ascentM: 0, timePct: 0 });
  w.n++;
  w.distPct = Math.max(w.distPct, r.distPct);
  w.ascentM = Math.max(w.ascentM, r.ascentDiffM);
  w.timePct = Math.max(w.timePct, r.timePct);
  wellMatched += r.ascentDiffM <= ASCENT_TOLERANCE_M ? 1 : 0;
  ascentErrSum += r.ascentDiffM;
  loErrSum += Math.abs(lo - r.want.ascentM);
  loMatched += Math.abs(lo - r.want.ascentM) <= ASCENT_TOLERANCE_M ? 1 : 0;
  used++;
}

if (used === 0) {
  console.log(`estimates-cache.test.js ok (skipped: no usable answers, ${unusable} without elevation or profile)`);
  process.exit(0);
}
for (const [profile, w] of Object.entries(worst).sort()) {
  console.log(`${profile.padEnd(16)} n=${String(w.n).padStart(3)}  distance ${w.distPct.toFixed(3)} %  ascent ${w.ascentM} m  time ${w.timePct.toFixed(2)} %`);
}
// the between-bounds check above passes a large miss; this catches the model drifting from the 10 m filter BRouter mostly applies
assert.ok(ascentErrSum / used <= MAX_MEAN_ASCENT_ERR_M, `mean ascent error ${(ascentErrSum / used).toFixed(1)} m`);
console.log(`${used} answers used, ${unusable} without elevation or a known profile; default 10 m filter within ${ASCENT_TOLERANCE_M} m of BRouter on ${wellMatched}, mean error ${(ascentErrSum / used).toFixed(1)} m; 5 m filter within ${ASCENT_TOLERANCE_M} m on ${loMatched}, mean error ${(loErrSum / used).toFixed(1)} m`);
console.log("estimates-cache.test.js ok");
