// MD5, Sync tile names and the Fog of World writer: two tiles Fog of World wrote (bench/fixtures/fow/) must come back
// byte for byte; synthetic maps cover the region and checksum rules.
//   node bench/fog-writer.test.js
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
require("./lib/load.js");
const { FogMap, parseTileId, MAP_WIDTH } = global.FogParser;
const { MD5, FogWriter } = global;
const pako = require("../app/vendor/pako_deflate.min.js");
global.pakoDeflate = pako; // what pakoDeflate.js does in the page, so writeSync's default deflate works
const deflate5 = (buf) => pako.deflate(buf, { level: 5 });

const HEADER = 32768, BLOCK = 515;
const FIX = path.join(__dirname, "fixtures", "fow");
const FIXTURES = [["23e4lltkkoke", 117660], ["cd36lltksiwo", 117659]];
const popcount = (bytes) => bytes.reduce((n, v) => n + v.toString(2).replace(/0/g, "").length, 0);
const sameBytes = (a, b, msg) => assert.ok(Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0, msg);

{ // published MD5 digests
  assert.equal(MD5.hex(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(MD5.hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(MD5.hex("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
  assert.ok(MD5.hex("117660").startsWith("23e4"));
  // lengths around the padding edges (55-65 bytes), and non-ASCII (UTF-8 bytes, not UTF-16 units)
  for (const str of ["a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "a".repeat(65), "a".repeat(1000), "é", "日本語🌍", "117659"]) {
    assert.equal(MD5.hex(str), crypto.createHash("md5").update(str, "utf8").digest("hex"), JSON.stringify(str.slice(0, 8)));
  }
}
{ // tile names, including the one-digit case
  for (const [name, id] of FIXTURES) {
    assert.equal(FogWriter.tileName(id), name);
    assert.equal(parseTileId(name), id, "the parser reads the name back");
  }
  assert.equal(FogWriter.tileName(7), MD5.hex("7").slice(0, 4) + "t" + "n");
  assert.equal(FogWriter.tileName(100), MD5.hex("100").slice(0, 4) + "loo" + "ee");
}
for (const [name, id] of FIXTURES) { // a tile Fog of World wrote comes back byte for byte
  const file = fs.readFileSync(path.join(FIX, name));
  const inflated = new Uint8Array(zlib.inflateSync(file));
  const map = new FogMap();
  assert.ok(map.addTile(name, inflated));
  const written = FogWriter.writeTile(Array.from(map.blocks(), (b) => ({ bx: b.bx, by: b.by, bitmap: b.bitmap, extra: b.extra })));
  assert.equal(written.length, inflated.length);
  sameBytes(written, inflated, `${name} decompressed`);
  // Node's own zlib is Chromium's fork and compresses differently from the reference zlib Fog of World used, so
  // the compressed bytes are checked against the pako build the page ships
  sameBytes(deflate5(written), file, `${name} compressed with pako level 5`);
  const out = FogWriter.writeSync(map, { deflate: deflate5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, name);
  sameBytes(out[0].bytes, file, `${name} through writeSync`);
  assert.equal(parseTileId(name), id);
}
{ // Node's zlib at level 5 is only reported against the file, not asserted: its bytes differ from Fog of World's
  for (const [name] of FIXTURES) {
    const file = fs.readFileSync(path.join(FIX, name));
    const bytes = new Uint8Array(zlib.inflateSync(file));
    const packed = zlib.deflateSync(bytes, { level: 5 });
    console.log(`node zlib ${process.versions.zlib} level 5 vs ${name}: ${Buffer.compare(packed, file) === 0 ? "identical" : "different"}`);
  }
}

const idOf = (tx, ty) => ty * MAP_WIDTH + tx;
const cellOf = (tx, ty, bx, by, x, y) => [(tx << 13) + (bx << 6) + x, (ty << 13) + (by << 6) + y];
const pairs = (cells) => Int32Array.from(cells.flat());
const inflateBytes = (out) => new Uint8Array(zlib.inflateSync(Buffer.from(out.bytes)));
const E = (b) => (b[0] << 16) | (b[1] << 8) | b[2];
// reads every set cell of a map back out of the written files, the way a Fog of World reader would
function cellsOf(files) {
  const map = new FogMap();
  for (const f of files) assert.ok(map.addTile(f.name, inflateBytes(f)));
  return map;
}
{ // the fixture tile with extra cells: imported blocks keep their region bits, new blocks carry region 0
  const name = FIXTURES[0][0];
  const map = new FogMap();
  map.addTile(name, new Uint8Array(zlib.inflateSync(fs.readFileSync(path.join(FIX, name)))));
  const tile = map.tiles.get(117660);
  const first = Array.from(tile.blocks())[0];
  const free = [0, 1, 2, 3].map((x) => cellOf(412, 229, first.bx, first.by, x, 0)).filter(([cx, cy]) => !map.isVisitedCell(cx, cy));
  assert.ok(free.length > 0, "the first block has room for the test");
  const added = map.addCells(pairs([...free, cellOf(412, 229, 127, 127, 63, 63)]));
  assert.equal(added, free.length + 1);
  const [file] = FogWriter.writeSync(map);
  const bytes = inflateBytes(file);
  const reread = new FogMap();
  reread.addTile(name, bytes);
  const out = Array.from(reread.tiles.get(117660).blocks());
  const orig = Array.from(tile.blocks());
  assert.equal(out.length, orig.length + 1);
  out.forEach((b, i) => {
    const imported = orig.find((o) => o.bx === b.bx && o.by === b.by);
    const label = `block ${b.bx},${b.by}`;
    assert.equal(E(b.extra) & 0x3fff, 2 * popcount(b.bitmap) + 1, `${label} checksum`);
    if (imported) assert.equal(E(b.extra) >> 14, E(imported.extra) >> 14, `${label} keeps its region bits`);
    else assert.equal(E(b.extra) >> 14, 0, `${label} is new, region 0`);
  });
  const changed = out.find((b) => b.bx === first.bx && b.by === first.by);
  assert.notEqual(E(changed.extra), E(first.extra), "a block that gained cells has a new checksum");
  assert.equal(E(changed.extra) >> 14, E(first.extra) >> 14);
  assert.equal(out[out.length - 1].bx, 127, "the new block is last in header order");
}
{ // synthetic overlay-only map: cells round-trip cell for cell, and the header indexes run 1..n
  const map = new FogMap();
  const wanted = [];
  for (const [tx, ty, bx, by, x, y] of [[3, 4, 0, 0, 0, 0], [3, 4, 0, 0, 63, 63], [3, 4, 50, 7, 1, 2], [200, 300, 127, 127, 5, 6], [3, 5, 1, 1, 8, 9]]) {
    wanted.push(cellOf(tx, ty, bx, by, x, y));
  }
  map.addCells(pairs(wanted));
  const files = FogWriter.writeSync(map);
  assert.deepEqual(files.map((f) => parseTileId(f.name)), [idOf(3, 4), idOf(3, 5), idOf(200, 300)].sort((a, b) => a - b));
  const back = cellsOf(files);
  for (const [cx, cy] of wanted) assert.equal(back.isVisitedCell(cx, cy), true, `cell ${cx},${cy}`);
  assert.equal(back.totalVisited(), wanted.length);
  const bytes = inflateBytes(files.find((f) => parseTileId(f.name) === idOf(3, 4)));
  assert.equal(bytes.length, HEADER + 2 * BLOCK);
  const dv = new DataView(bytes.buffer);
  assert.equal(dv.getUint16(0, true), 1);
  assert.equal(dv.getUint16((7 * 128 + 50) * 2, true), 2);
  const b1 = HEADER + BLOCK;
  assert.equal(E(bytes.subarray(b1 + 512, b1 + 515)), 2 * 1 + 1, "new block: region 0, checksum 2n+1");
  const b0 = HEADER;
  assert.equal(E(bytes.subarray(b0 + 512, b0 + 515)), 2 * 2 + 1);
}
{ // empty tiles and blocks are never written
  const map = new FogMap();
  const data = new Uint8Array(HEADER + 2 * BLOCK);
  const dv = new DataView(data.buffer);
  dv.setUint16(0, 1, true);
  dv.setUint16(2, 2, true);
  data[HEADER + BLOCK] = 0x80; // block 2 has one cell, block 1 none
  map.addTile("0000" + "ll" + "xx", data);  // tile id 11
  map.addTile("0000" + "lh" + "xx", new Uint8Array(HEADER)); // tile id 12 with no blocks at all
  const files = FogWriter.writeSync(map);
  assert.equal(files.length, 1);
  const bytes = inflateBytes(files[0]);
  assert.equal(bytes.length, HEADER + BLOCK, "only the block with a cell");
  assert.equal(new DataView(bytes.buffer).getUint16(2, true), 1);
  assert.equal(FogWriter.writeSync(new FogMap()).length, 0);
  assert.equal(FogWriter.writeTile([{ bx: 0, by: 0, bitmap: new Uint8Array(512), extra: null }]).length, HEADER, "an empty block is skipped by writeTile too");
}
{ // the default deflate comes from the pako build the page loads; without it the error names the cause
  const map = new FogMap();
  map.addCells(pairs([cellOf(1, 1, 0, 0, 0, 0)]));
  const [f] = FogWriter.writeSync(map);
  sameBytes(f.bytes, deflate5(FogWriter.writeTile(Array.from(map.blocks()))), "default is pako level 5");
  assert.equal(f.bytes[0], 0x78);
  delete global.pakoDeflate;
  try { assert.throws(() => FogWriter.writeSync(map), /pako/i); } finally { global.pakoDeflate = pako; }
}
console.log("fog-writer.test.js ok");
