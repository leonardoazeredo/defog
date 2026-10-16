// bench/compare.js passes and fails on the cases it names; hand-made result files, no network.
//   node bench/compare.test.js
"use strict";
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compare-"));
const ok = [[13.7, 51], [13.701, 51], [13.702, 51], [13.703, 51]];
const jump = [[13.7, 51], [13.701, 51], [13.715, 51], [13.716, 51]]; // ~1 km between two vertices
const scenario = (name, area, coords, ms = 100) => ({ scenario: name, ms, results: [{ areaKm2: area, km: 1, coords }] });
function run(base, cand) {
  const [b, c] = [base, cand].map((x, i) => { const f = path.join(dir, `f${i}${Math.random()}.json`); fs.writeFileSync(f, JSON.stringify({ scenarios: x })); return f; });
  return spawnSync(process.execPath, [path.join(__dirname, "compare.js"), b, c]).status;
}
const base = [scenario("a", 1, ok), scenario("b", 2, ok)];

assert.equal(run(base, [scenario("a", 0.95, ok), scenario("b", 1.9, ok)]), 0, "95% of the baseline passes");
assert.equal(run(base, [scenario("a", 0.5, ok), scenario("b", 1, ok)]), 1, "half the baseline fails");
assert.equal(run(base, [scenario("a", 1, jump), scenario("b", 2, ok)]), 1, "a 1 km vertex gap fails");
assert.equal(run(base, [scenario("a", 1, ok, 6000), scenario("b", 2, ok)]), 1, "a slow run fails");
assert.equal(run(base, [scenario("a", 1, ok), { scenario: "b", empty: true, reason: "too-long" }]), 0, "a declined long loop is skipped, not scored");
assert.equal(run(base, [scenario("a", 1, ok), { scenario: "b", empty: true, reason: "streets-fetch" }]), 1, "any other empty result scores zero");
console.log("compare.test.js ok");
