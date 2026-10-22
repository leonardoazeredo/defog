// Every plaintext export (Fog of World export, GPX, KML, Open in Google Maps) shows its warning first, Cancel
// runs nothing, and no log line in the page carries a position.
//   node bench/export-warnings.test.js
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
global.window = global;
require("../app/src/exportWarning.js");
const { ExportWarning } = global;

function fakeEl() {
  const listeners = {};
  return {
    hidden: true,
    textContent: "",
    focused: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    click() { for (const fn of listeners.click || []) fn({}); },
    focus() { this.focused = true; },
    fire(type, ev) { for (const fn of listeners[type] || []) fn(ev); },
  };
}
function fakeDoc() {
  const els = {};
  for (const id of ["exportWarning", "exportWarningText", "exportContinue", "exportCancel"]) els[id] = fakeEl();
  const doc = fakeEl();
  doc.getElementById = (id) => els[id];
  return { doc, els };
}
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  for (const kind of ["fog", "gpx", "kml", "maps"]) {
    // Cancel
    {
      const { doc, els } = fakeDoc();
      const warn = ExportWarning.install({ doc });
      let ran = 0;
      const done = warn.guard(kind, () => { ran++; })();
      assert.equal(els.exportWarning.hidden, false, kind + ": the card is shown first");
      assert.equal(els.exportWarningText.textContent, ExportWarning.TEXT[kind], kind + ": it says what the file shows");
      assert.equal(els.exportCancel.focused, true, kind + ": the safe answer has the focus");
      assert.equal(ran, 0, kind + ": nothing runs before an answer");
      els.exportCancel.click();
      await done;
      assert.equal(ran, 0, kind + ": Cancel runs nothing");
      assert.equal(els.exportWarning.hidden, true);
    }
    // Continue
    {
      const { doc, els } = fakeDoc();
      const warn = ExportWarning.install({ doc });
      let ran = 0;
      const done = warn.guard(kind, () => { ran++; })();
      assert.equal(ran, 0);
      els.exportContinue.click();
      await done;
      assert.equal(ran, 1, kind + ": Continue runs the export once");
      assert.equal(els.exportWarning.hidden, true);
      els.exportContinue.click();
      await settle();
      assert.equal(ran, 1, kind + ": a stray click on Continue runs nothing");
    }
  }

  // Escape is Cancel
  {
    const { doc, els } = fakeDoc();
    const warn = ExportWarning.install({ doc });
    let ran = 0;
    const done = warn.guard("gpx", () => { ran++; })();
    doc.fire("keydown", { key: "Escape" });
    await done;
    assert.equal(ran, 0);
    assert.equal(els.exportWarning.hidden, true);
  }

  // asking again while a card is open cancels the first export
  {
    const { doc, els } = fakeDoc();
    const warn = ExportWarning.install({ doc });
    let first = 0, second = 0;
    const a = warn.guard("gpx", () => { first++; })();
    const b = warn.guard("maps", () => { second++; })();
    assert.equal(els.exportWarningText.textContent, ExportWarning.TEXT.maps);
    els.exportContinue.click();
    await Promise.all([a, b]);
    assert.equal(first, 0, "the replaced request runs nothing");
    assert.equal(second, 1);
  }

  // an unknown kind never runs its action
  {
    const { doc } = fakeDoc();
    const warn = ExportWarning.install({ doc });
    let ran = 0;
    await warn.guard("nope", () => { ran++; })();
    assert.equal(ran, 0);
  }

  // what each warning says
  assert.match(ExportWarning.TEXT.fog, /unencrypted and shows the places you have been/);
  assert.match(ExportWarning.TEXT.gpx, /unencrypted and shows the route/);
  assert.match(ExportWarning.TEXT.kml, /unencrypted and shows the route/);
  assert.match(ExportWarning.TEXT.maps, /Google/);

  // main.js reaches each plaintext sink only through a guard
  const root = path.join(__dirname, "..", "app");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8").split("\n");
  for (const [sink, kind] of [["route.downloadGPX(", "gpx"], ["route.downloadKML(", "kml"], ["window.open(", "maps"], ["FowExport.run(", "fog"]]) {
    const lines = main.filter((l) => l.includes(sink));
    assert.ok(lines.length >= 1, sink + " is used in main.js");
    for (const l of lines) assert.ok(l.includes('guard("' + kind + '"'), sink + " sits behind guard(\"" + kind + "\"): " + l.trim());
  }

  // the page's own script order puts the helpers before main.js
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const at = (f) => html.indexOf('src="src/' + f + '"');
  for (const f of ["exportWarning.js", "fowExport.js"]) assert.ok(at(f) > 0 && at(f) < at("main.js"), f + " loads before main.js");
  assert.ok(at("fowExport.js") > at("fogWriter.js"), "fowExport.js loads after fogWriter.js");
  for (const id of ["exportWarning", "exportWarningText", "exportContinue", "exportCancel", "exportFow"]) {
    assert.ok(html.includes('id="' + id + '"'), "index.html has #" + id);
  }

  // no console call in the page prints a reason's `why`, an explanation of a failed route, or a position
  const srcDir = path.join(root, "src");
  const risky = /\b(why|explain|latlng|lat|lng|lon|coords|wps|bounds)\b/;
  for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(srcDir, file), "utf8").split("\n");
    text.forEach((line, i) => {
      const m = line.match(/console\.(?:debug|log|info|warn|error)\((.*)$/);
      if (!m) return;
      assert.ok(!risky.test(m[1].replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "")), file + ":" + (i + 1) + " logs something that may hold a position: " + line.trim());
    });
  }
  const sug = main.find((l) => l.includes('console.debug("[suggest]"'));
  assert.ok(sug && /console\.debug\("\[suggest\]", s\.reason\);/.test(sug), "the suggest debug line prints the reason only");

  console.log("export-warnings.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
