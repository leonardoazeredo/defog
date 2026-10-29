// FowExport: the Fog of World export's chunks. No DOM, no network.
//   node bench/fow-export.test.js
"use strict";
const assert = require("node:assert/strict");
global.window = global;
require("../app/src/fowExport.js");
const { FowExport } = global;

const bytesOf = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255);
const unb64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));

// base64 of a long array equals Buffer's, and decodes back
{
  const b = bytesOf(100_003, 5);
  assert.equal(FowExport.toBase64(b), Buffer.from(b).toString("base64"));
  assert.equal(FowExport.toBase64(new Uint8Array(0)), "");
}

// a file over the limit splits into chunks of at most 1 MiB that join back; all share one export id and file count
{
  const big = bytesOf(FowExport.CHUNK_BYTES * 2 + 17, 1);
  const small = bytesOf(10, 2);
  const chunks = FowExport.chunksOf([{ name: "aaaa", bytes: big }, { name: "bbbb", bytes: small }], "id-1");
  assert.equal(chunks.length, 4);
  assert.ok(chunks.every((c) => c.exportId === "id-1" && c.files === 2));
  const a = chunks.filter((c) => c.name === "aaaa");
  assert.deepEqual(a.map((c) => [c.index, c.total]), [[0, 3], [1, 3], [2, 3]]);
  for (const c of chunks) assert.ok(c.data.length <= Math.ceil(FowExport.CHUNK_BYTES / 3) * 4, "within the bridge's limit");
  const joined = Buffer.concat(a.map((c) => unb64(c.data)));
  assert.ok(joined.equals(Buffer.from(big)));
  assert.ok(unb64(chunks[3].data).every((v, i) => v === small[i]));
}

// a file of no bytes is still one chunk
{
  const chunks = FowExport.chunksOf([{ name: "cccc", bytes: new Uint8Array(0) }], "id-2");
  assert.deepEqual(chunks, [{ exportId: "id-2", name: "cccc", index: 0, total: 1, files: 1, data: "" }]);
}

// run writes the fog, sends every chunk to the phone and returns the file count
{
  const fogMap = {};
  global.FogWriter = { writeSync: (m) => (m === fogMap ? [{ name: "aaaa", bytes: bytesOf(5, 3) }, { name: "bbbb", bytes: bytesOf(6, 4) }] : []) };
  const sent = [];
  const n = FowExport.run({ fogMap, phone: { exportBinary: (c) => sent.push(c) }, exportId: "id-3" });
  assert.equal(n, 2);
  assert.deepEqual(sent.map((c) => c.name), ["aaaa", "bbbb"]);
}

// no fog sends nothing; no phone or a failing writer reports null and sends nothing
{
  const sent = [];
  const phone = { exportBinary: (c) => sent.push(c) };
  global.FogWriter = { writeSync: () => [] };
  assert.equal(FowExport.run({ fogMap: {}, phone, exportId: "x" }), 0);
  assert.equal(FowExport.run({ fogMap: {}, phone: null, exportId: "x" }), null);
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a.join(" "));
  global.FogWriter = { writeSync: () => { throw new RangeError("tile 48.12345"); } };
  assert.equal(FowExport.run({ fogMap: {}, phone, exportId: "x" }), null);
  console.warn = warn;
  assert.deepEqual(sent, []);
  assert.deepEqual(logged, ["[export] Fog of World export failed RangeError"], "the class only");
}

// a file of exactly CHUNK_BYTES is one chunk, one byte more is two
{
  assert.equal(FowExport.chunksOf([{ name: "dddd", bytes: new Uint8Array(FowExport.CHUNK_BYTES) }], "e").length, 1);
  assert.equal(FowExport.chunksOf([{ name: "dddd", bytes: new Uint8Array(FowExport.CHUNK_BYTES + 1) }], "e").length, 2);
}

// The button: one export at a time, "Preparing…" painted before the page freezes, and the phone's answer shown.
function buttonRig({ canExport = true } = {}) {
  const button = { disabled: false };
  const status = { textContent: "" };
  const deferred = [];
  const timers = new Map();
  let nextTimer = 1;
  const ids = ["x1", "x2", "x3"];
  const ctl = FowExport.button({
    button, status,
    canExport: () => canExport,
    newId: () => ids.shift(),
    defer: (fn) => deferred.push(fn),
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  const fire = (ms) => {
    for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); }
  };
  const runDeferred = () => { while (deferred.length) deferred.shift()(); };
  return { button, status, ctl, deferred, timers, fire, runDeferred };
}

// a second tap while an export is pending starts nothing; the button stays disabled until the phone answers
{
  const r = buttonRig();
  const sent = [];
  r.ctl.start((id) => { sent.push(id); return 2; });
  assert.equal(r.status.textContent, "Preparing…");
  assert.equal(r.button.disabled, true);
  assert.deepEqual(sent, [], "the writer runs only once the line has painted");
  r.ctl.start((id) => { sent.push(id); return 2; });
  r.runDeferred();
  assert.deepEqual(sent, ["x1"]);
  r.ctl.refresh();
  assert.equal(r.button.disabled, true, "a fog change does not re-enable a pending export");
  r.ctl.onStatus({ exportId: "x1", state: "saving" });
  assert.equal(r.status.textContent, "Choose where to save it…");
  assert.equal(r.button.disabled, true);
  r.ctl.onStatus({ exportId: "x1", state: "saved" });
  assert.equal(r.status.textContent, "Saved.");
  assert.equal(r.button.disabled, false);
  r.fire(FowExport.STATUS_MS);
  assert.equal(r.status.textContent, "", "the result line expires");
}

// cancelled and failed end the export too; a status for another export is ignored
{
  const r = buttonRig();
  r.ctl.start(() => 1);
  r.runDeferred();
  r.ctl.onStatus({ exportId: "other", state: "failed" });
  assert.equal(r.button.disabled, true);
  r.ctl.onStatus({ exportId: "x1", state: "cancelled" });
  assert.equal(r.status.textContent, "Not saved.");
  assert.equal(r.button.disabled, false);
  r.ctl.start(() => 1);
  r.runDeferred();
  r.ctl.onStatus({ exportId: "x2", state: "failed" });
  assert.equal(r.status.textContent, "Couldn't save the export.");
  assert.equal(r.button.disabled, false);
}

// nothing to export or a writer failure ends at once
{
  const r = buttonRig();
  r.ctl.start(() => 0);
  r.runDeferred();
  assert.equal(r.status.textContent, "There is no fog to export yet.");
  assert.equal(r.button.disabled, false);
  r.ctl.start(() => null);
  r.runDeferred();
  assert.equal(r.status.textContent, "Couldn't write the export.");
  assert.equal(r.button.disabled, false);
  assert.equal([...r.timers.values()].filter((t) => t.ms === FowExport.REPLY_MS).length, 0);
}

// no answer from the phone within REPLY_MS frees the button; once the picker is open there is no limit
{
  const r = buttonRig();
  r.ctl.start(() => 1);
  r.runDeferred();
  r.fire(FowExport.REPLY_MS);
  assert.equal(r.status.textContent, "The app did not answer. Try again.");
  assert.equal(r.button.disabled, false);
  r.ctl.onStatus({ exportId: "x1", state: "saved" });
  assert.equal(r.status.textContent, "The app did not answer. Try again.", "a late answer is not shown as this export's");

  r.ctl.start(() => 1);
  r.runDeferred();
  r.ctl.onStatus({ exportId: "x2", state: "saving" });
  r.fire(FowExport.REPLY_MS);
  assert.equal(r.status.textContent, "Choose where to save it…");
  assert.equal(r.button.disabled, true);
}

// a send that throws does not leave the button stuck
{
  const r = buttonRig();
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a.join(" "));
  r.ctl.start(() => { throw new TypeError("at 48.12345"); });
  r.runDeferred();
  console.warn = warn;
  assert.equal(r.status.textContent, "Couldn't write the export.");
  assert.equal(r.button.disabled, false);
  assert.deepEqual(logged, ["[export] Fog of World export failed TypeError"]);
}

// refresh follows canExport while nothing is pending
{
  const r = buttonRig({ canExport: false });
  r.ctl.refresh();
  assert.equal(r.button.disabled, true);
  r.ctl.start(() => 1);
  assert.deepEqual(r.deferred, [], "a disabled export does not start");
}

console.log("fow-export.test.js ok");
