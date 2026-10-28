// main.js is a browser IIFE, so these tests lift single functions out of its source and run them
// against stubs: the Fog of World export button is wired to its controller, fogChanged survives a throwing step and
// drops stale suggestions, finishLoad goes through fogChanged, and activity-only fog fits the map once.
//   node bench/main-fog-status.test.js
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "app", "src", "main.js"), "utf8");
function fnText(name) {
  const start = src.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} not found in main.js`);
  return src.slice(start, src.indexOf("\n  }\n", start) + 4);
}
function line(re, what) {
  const m = src.match(re);
  assert.ok(m, `main.js declares ${what}`);
  return m[0];
}

// ---- the Fog of World export button: FowExport.button owns it (bench/fow-export.test.js); main.js must hand it
// the phone's answers and let it decide when the button is enabled
{
  assert.match(src, /exportStatus: fowExport\.onStatus/);
  assert.match(fnText("updateFowButton"), /fowExport\.refresh\(\)/);
  assert.doesNotMatch(fnText("updateFowButton"), /fowBtn\.disabled/, "only the controller sets disabled");
}

// ---- fogChanged
function fogScope(over) {
  const calls = [];
  const s = {
    fogLayer: null,
    fogMap: { hasFog: () => true, tileCount: 0, latLngBounds: () => ({ b: 1 }) },
    streets: { invalidateFrac: () => calls.push("invalidateFrac") },
    streetsLayer: { invalidateFog: () => calls.push("invalidateFog") },
    updateDefog: () => calls.push("updateDefog"),
    syncSug: () => calls.push("syncSug"),
    map: { fitBounds: () => { calls.push("fitBounds"); s.mapTouched = true; } }, // Leaflet fires movestart for it
    suggest: { clearResults: () => calls.push("clearResults") },
    lastSug: null,
    mapTouched: false,
    console: { warn: (...a) => calls.push("warn:" + a[1]) },
  };
  s.ensureLayer = () => { calls.push("ensureLayer"); s.fogLayer = { redraw: () => calls.push("redraw") }; };
  Object.assign(s, over);
  return { s, calls };
}
// main.js keeps fogLayer, lastSug, mapTouched and fitted as closure `let`s; the lifted copy reads them off `s`.
function liftFogChanged(s) {
  const state = ["fogLayer", "lastSug", "mapTouched"];
  const names = Object.keys(s).filter((k) => !state.includes(k));
  const get = new Function("s", ...names,
    `let fitted = ${line(/^ {2}let fitted\b.*$/m, "fitted").replace(/^.*= */, "").replace(/;.*$/, "")};
     return () => {
       const { fogLayer, lastSug, mapTouched } = s;
       let fogLayerV = fogLayer;
       ${fnText("fogChanged").replace("function fogChanged()", "const run = ()=>").replace(/\bfogLayer\b/g, "fogLayerV").replace(/\blastSug\b/g, "s.lastSug").replace(/\bmapTouched\b/g, "s.mapTouched").replace(/\bensureLayer\(\)/g, "(ensureLayer(), fogLayerV = s.fogLayer)")}
       run(); s.fogLayer = fogLayerV;
     };`);
  return get(s, ...names.map((k) => s[k]));
}

{
  const { s, calls } = fogScope({});
  s.streets.invalidateFrac = () => { throw new TypeError("boom"); };
  liftFogChanged(s)();
  assert.ok(calls.includes("invalidateFog") && calls.includes("updateDefog") && calls.includes("syncSug"), calls.join());
  assert.ok(calls.includes("warn:TypeError"), "logs the class only");
}
{
  const { s, calls } = fogScope({ lastSug: { list: [{}] } });
  liftFogChanged(s)();
  assert.ok(calls.includes("clearResults"), "shown suggestions were scored on the old fog");
}
for (const lastSug of [null, { loading: true }, { error: true }, { empty: true }]) {
  const { s, calls } = fogScope({ lastSug });
  liftFogChanged(s)();
  assert.ok(!calls.includes("clearResults"), "nothing stale to drop: " + JSON.stringify(lastSug));
}
{
  const { s, calls } = fogScope({});
  const f = liftFogChanged(s);
  f(); f();
  assert.equal(calls.filter((c) => c === "fitBounds").length, 1, "activity-only fog fits the map once");
  assert.equal(s.mapTouched, false, "our own fit does not count as the person moving the map");
}
{
  const { s, calls } = fogScope({ mapTouched: true });
  liftFogChanged(s)();
  assert.ok(!calls.includes("fitBounds"), "not under a map the person already moved");
}
{
  const { s, calls } = fogScope({ fogMap: { hasFog: () => true, tileCount: 4, latLngBounds: () => ({}) } });
  liftFogChanged(s)();
  assert.ok(!calls.includes("fitBounds"), "an import has its own fit in finishLoad");
}

// ---- any move, including one started from the sidebar, marks the map as touched
assert.match(src, /map\.on\("movestart", \(\) => \{ mapTouched = true; \}\)/);

// ---- finishLoad hands the shared refresh to fogChanged
{
  const body = fnText("finishLoad");
  assert.match(body, /fogChanged\(\)/);
  assert.doesNotMatch(body, /invalidateFrac|invalidateFog|syncSug|updateDefog/, "no second copy of the refresh");
}
console.log("main-fog-status ok");
