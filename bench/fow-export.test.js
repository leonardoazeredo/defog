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
  const n = FowExport.run({ fogMap, phone: { exportBinary: (c) => sent.push(c) }, newId: () => "id-3" });
  assert.equal(n, 2);
  assert.deepEqual(sent.map((c) => c.name), ["aaaa", "bbbb"]);
}

// no fog sends nothing; no phone or a failing writer reports null and sends nothing
{
  const sent = [];
  const phone = { exportBinary: (c) => sent.push(c) };
  global.FogWriter = { writeSync: () => [] };
  assert.equal(FowExport.run({ fogMap: {}, phone, newId: () => "x" }), 0);
  assert.equal(FowExport.run({ fogMap: {}, phone: null, newId: () => "x" }), null);
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a.join(" "));
  global.FogWriter = { writeSync: () => { throw new RangeError("tile 48.12345"); } };
  assert.equal(FowExport.run({ fogMap: {}, phone, newId: () => "x" }), null);
  console.warn = warn;
  assert.deepEqual(sent, []);
  assert.deepEqual(logged, ["[export] Fog of World export failed RangeError"], "the class only");
}

console.log("fow-export.test.js ok");
