// FogMap overlay cells, version, block extra bytes and the merged block listing; synthetic tiles, no Sync/.
//   node bench/fog-map.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { FogMap, MAP_WIDTH } = global.FogParser;

const HEADER = 32768, BLOCK = 515;
const idOf = (tx, ty) => ty * MAP_WIDTH + tx;
// the file name only has to round-trip through parseTileId, which ignores the md5 prefix and the last two letters
const nameOf = (id) => "0000" + String(id).split("").map((d) => "olhwjsktri"[d]).join("") + "xx";
// blocks: [{bx, by, cells: [[x, y], ...], extra: [b0, b1, b2]}] in the order they are stored
function tileBytes(blocks) {
  const data = new Uint8Array(HEADER + BLOCK * blocks.length);
  const dv = new DataView(data.buffer);
  blocks.forEach((b, i) => {
    dv.setUint16((b.by * 128 + b.bx) * 2, i + 1, true);
    const at = HEADER + i * BLOCK;
    for (const [x, y] of b.cells) data[at + (x >> 3) + y * 8] |= 1 << (7 - (x & 7));
    data.set(b.extra || [0, 0, 0], at + 512);
  });
  return data;
}
const cellOf = (tx, ty, bx, by, x, y) => [(tx << 13) + (bx << 6) + x, (ty << 13) + (by << 6) + y];
const pairs = (cells) => Int32Array.from(cells.flat());
const sameBytes = (a, b) => assert.deepEqual(Array.from(a), Array.from(b));

{ // addCells: the cells show, the total grows by their number, repeats add nothing, the version moves
  const map = new FogMap();
  const cells = [cellOf(10, 20, 3, 4, 5, 6), cellOf(10, 20, 3, 4, 6, 6), cellOf(11, 20, 0, 0, 0, 0)];
  const v0 = map.version;
  assert.equal(map.totalVisited(), 0);
  assert.equal(map.addCells(pairs(cells)), 3);
  assert.ok(map.version > v0, "version moved");
  for (const [cx, cy] of cells) assert.equal(map.isVisitedCell(cx, cy), true);
  assert.equal(map.isVisitedCell(cells[0][0] + 5, cells[0][1]), false);
  assert.equal(map.totalVisited(), 3);
  const v1 = map.version;
  assert.equal(map.addCells(pairs([cells[1]])), 0, "a cell the overlay already holds");
  assert.equal(map.totalVisited(), 3);
  assert.ok(map.version > v1, "version moves on every call");
  assert.equal(map.addCells(pairs([cells[1], cellOf(10, 20, 3, 4, 7, 6)])), 1, "duplicates in one call count once");
  assert.equal(map.totalVisited(), 4);
}
{ // a cell the import already covers is ignored, so the counts add up
  const map = new FogMap();
  const inside = cellOf(5, 6, 1, 2, 3, 4), other = cellOf(5, 6, 1, 2, 4, 4);
  map.addTile(nameOf(idOf(5, 6)), tileBytes([{ bx: 1, by: 2, cells: [[3, 4]] }]));
  assert.equal(map.totalVisited(), 1);
  assert.equal(map.addCells(pairs([inside, other])), 1);
  assert.equal(map.totalVisited(), 2);
}
{ // out-of-world cells are ignored, not counted
  const map = new FogMap();
  assert.equal(map.addCells(pairs([[-1, 0], [0, 4194304], [4194304, 5]])), 0);
  assert.equal(map.totalVisited(), 0);
}
{ // clearOverlay removes the overlay cells and keeps the import
  const map = new FogMap();
  const cell = cellOf(5, 6, 1, 2, 3, 4), added = cellOf(5, 6, 9, 9, 0, 0);
  map.addTile(nameOf(idOf(5, 6)), tileBytes([{ bx: 1, by: 2, cells: [[3, 4]] }]));
  map.addCells(pairs([added]));
  const v = map.version;
  map.clearOverlay();
  assert.ok(map.version > v);
  assert.equal(map.isVisitedCell(...added), false);
  assert.equal(map.isVisitedCell(...cell), true);
  assert.equal(map.totalVisited(), 1);
}
{ // countVisitedInCellRect and latLngBounds include the overlay
  const map = new FogMap();
  map.addTile(nameOf(idOf(5, 6)), tileBytes([{ bx: 1, by: 2, cells: [[3, 4]] }]));
  const [ax, ay] = cellOf(5, 6, 1, 2, 3, 5), [bx, by] = cellOf(20, 30, 0, 0, 1, 1);
  const rect = (x0, y0, x1, y1) => map.countVisitedInCellRect(x0, y0, x1, y1);
  const [ix, iy] = cellOf(5, 6, 1, 2, 3, 4);
  assert.equal(rect(ix, iy, ix + 1, iy + 1), 1);
  map.addCells(pairs([[ax, ay], [bx, by], [ix, iy]]));
  assert.equal(rect(ix, iy, ix + 1, iy + 2), 2, "import cell plus overlay cell, the repeat not double counted");
  assert.equal(rect(bx, by, bx + 1, by + 1), 1, "overlay cell in a tile the import lacks");
  assert.equal(rect(0, 0, 4194304, 4194304), 3);
  const [[s], [, e]] = map.latLngBounds();
  const far = global.FogParser.tileToLngLat(21, 31);
  assert.ok(e >= far.lng - 1e-9 && s <= far.lat + 1e-9, "bounds reach the overlay tile");
  map.clearOverlay();
  assert.ok(map.latLngBounds()[1][1] < far.lng, "bounds shrink back to the import");
  assert.equal(rect(0, 0, 4194304, 4194304), 1);
}
{ // Tile.blockExtra / Tile.blocks: header order, extra bytes as a view after the bitmap
  const map = new FogMap();
  // stored out of header order on purpose: header order is by*128+bx, not storage order
  const data = tileBytes([
    { bx: 7, by: 3, cells: [[0, 0]], extra: [1, 2, 3] },
    { bx: 2, by: 0, cells: [[63, 63]], extra: [4, 5, 6] },
  ]);
  map.addTile(nameOf(idOf(1, 1)), data);
  const tile = map.tiles.get(idOf(1, 1));
  sameBytes(tile.blockExtra(1), [1, 2, 3]);
  sameBytes(tile.blockExtra(2), [4, 5, 6]);
  assert.equal(tile.blockExtra(1).byteOffset, data.byteOffset + HEADER + 512, "a view, not a copy");
  const got = Array.from(tile.blocks());
  assert.deepEqual(got.map((b) => [b.bx, b.by]), [[2, 0], [7, 3]]);
  assert.equal(got[0].bitmap.length, 512);
  assert.equal(got[0].bitmap[511], 1);
  sameBytes(got[1].extra, [1, 2, 3]);
}
{ // FogMap.blocks: an overlay cell in an imported block is ORed in and the imported extra bytes stay
  const map = new FogMap();
  const extra = [0x23, 0xc0, 0x03];
  map.addTile(nameOf(idOf(5, 6)), tileBytes([{ bx: 1, by: 2, cells: [[3, 4]], extra }]));
  map.addCells(pairs([cellOf(5, 6, 1, 2, 0, 0)]));
  const blocks = Array.from(map.blocks());
  assert.equal(blocks.length, 1);
  const b = blocks[0];
  assert.deepEqual([b.tx, b.ty, b.bx, b.by], [5, 6, 1, 2]);
  assert.equal(b.bitmap[0], 0x80);
  assert.equal(b.bitmap[0 + 4 * 8], 0x10);
  sameBytes(b.extra, extra);
  assert.equal(b.bitmap.reduce((n, v) => n + v.toString(2).replace(/0/g, "").length, 0), 2);
}
{ // an overlay cell in a new block has extra null; tiles ascend by id and blocks by header order
  const map = new FogMap();
  map.addTile(nameOf(idOf(5, 6)), tileBytes([{ bx: 9, by: 2, cells: [[3, 4]], extra: [9, 9, 9] }]));
  map.addCells(pairs([
    cellOf(5, 6, 1, 2, 0, 0),   // new block before the imported one in header order
    cellOf(5, 6, 9, 9, 0, 0),   // new block after it
    cellOf(2, 6, 0, 0, 0, 0),   // new tile with a lower id
    cellOf(5, 1, 0, 0, 0, 0),   // new tile with a lower id still
  ]));
  const got = Array.from(map.blocks());
  assert.deepEqual(got.map((b) => [b.tx, b.ty, b.bx, b.by]),
    [[5, 1, 0, 0], [2, 6, 0, 0], [5, 6, 1, 2], [5, 6, 9, 2], [5, 6, 9, 9]]);
  assert.deepEqual(got.map((b) => b.extra === null), [true, true, true, false, true]);
}
{ // an imported block with no cells is not listed; one that gains an overlay cell is
  const map = new FogMap();
  map.addTile(nameOf(idOf(5, 6)), tileBytes([{ bx: 1, by: 1, cells: [] }, { bx: 2, by: 1, cells: [] }]));
  assert.equal(Array.from(map.blocks()).length, 0);
  map.addCells(pairs([cellOf(5, 6, 2, 1, 7, 7)]));
  const got = Array.from(map.blocks());
  assert.deepEqual(got.map((b) => [b.bx, b.by]), [[2, 1]]);
  sameBytes(got[0].extra, [0, 0, 0]);
}
{ // addTile moves the version too
  const map = new FogMap();
  const v = map.version;
  map.addTile(nameOf(idOf(1, 1)), tileBytes([{ bx: 0, by: 0, cells: [[0, 0]] }]));
  assert.ok(map.version > v);
}
console.log("fog-map.test.js ok");
