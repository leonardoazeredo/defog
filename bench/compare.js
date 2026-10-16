// Acceptance check: a candidate bench run against a baseline run (both bench/run.js output).
//   node bench/compare.js <baseline.json> <candidate.json>
// Passes when the median over scenarios of best-card area vs the baseline is at least
// MIN_MEDIAN, no route jumps a gap (a stretch the street graph could not have walked),
// and every scenario ran within MAX_MS. Scenarios the app declines on purpose (a loop
// longer than it supports) are listed as skipped, not scored. Run the candidate twice: the first run pays for
// Overpass fetches, the second (cache warm) is the one whose time means anything.
"use strict";
const fs = require("fs");

const MIN_MEDIAN = 0.9;
const MAX_GAP_M = 700; // real way segments reach ~600 m (bridges) and the BRouter baseline has 446 m; a jump over missing streets is not a single way
const MAX_MS = 5000;

const load = (f) => new Map(JSON.parse(fs.readFileSync(f, "utf8")).scenarios.map((s) => [s.scenario, s]));
const bestArea = (s) => Math.max(0, ...((s && s.results) || []).map((r) => r.areaKm2));

// longest vertex-to-vertex jump, ignoring the first and last segment (point-to-street stubs)
function maxGapM(coords) {
  const kx = 111320 * Math.cos(coords[0][1] * Math.PI / 180), ky = 110540;
  let gap = 0;
  for (let i = 2; i < coords.length - 1; i++)
    gap = Math.max(gap, Math.hypot((coords[i][0] - coords[i - 1][0]) * kx, (coords[i][1] - coords[i - 1][1]) * ky));
  return gap;
}

const [baseFile, candFile] = process.argv.slice(2);
if (!baseFile || !candFile) { console.error("usage: node bench/compare.js <baseline.json> <candidate.json>"); process.exit(2); }
const base = load(baseFile), cand = load(candFile);

const ratios = [];
const rows = [];
let failed = false;
for (const [name, b] of base) {
  const c = cand.get(name);
  if (c && c.empty && c.reason === "too-long") { rows.push({ scenario: name, base: bestArea(b), cand: "skipped: too long" }); continue; }
  const ratio = bestArea(b) > 0 ? bestArea(c) / bestArea(b) : 1;
  const gap = Math.max(0, ...((c && c.results) || []).map((r) => maxGapM(r.coords)));
  const ms = c && c.ms != null ? c.ms : null;
  if (gap > MAX_GAP_M || (ms != null && ms > MAX_MS)) failed = true;
  ratios.push(ratio);
  rows.push({ scenario: name, base: bestArea(b), cand: bestArea(c), ratio: +ratio.toFixed(2), maxGapM: Math.round(gap), ms });
}
console.table(rows);
ratios.sort((a, b) => a - b);
const mid = ratios.length >> 1;
const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
console.log(`median ratio ${median.toFixed(2)} (need >= ${MIN_MEDIAN}), gaps > ${MAX_GAP_M} m and runs > ${MAX_MS} ms fail`);
if (median < MIN_MEDIAN) failed = true;
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
