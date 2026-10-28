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

{ // addCells: the cells show, the total grows by their number, repeats add nothing, the version moves only when cells were added
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
  assert.equal(map.version, v1, "nothing added, so caches built on the fog stay valid");
  const d = cellOf(10, 20, 3, 4, 7, 6);
  assert.equal(map.addCells(pairs([d, d, cells[1]])), 1, "a repeat inside one call counts once");
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
{ // wrong shapes are refused: a NaN coordinate would otherwise land on cell (0, 0) through the bit operations
  const map = new FogMap();
  assert.throws(() => map.addCells([5, 6]), TypeError);
  assert.throws(() => map.addCells(new Float64Array([NaN, NaN])), TypeError);
  assert.throws(() => map.addCells(Int32Array.from([1, 2, 3])), RangeError);
  assert.equal(map.totalVisited(), 0);
}
{ // out-of-world cells are ignored, not counted
  const map = new FogMap();
  const v = map.version;
  assert.equal(map.addCells(pairs([[-1, 0], [0, 4194304], [4194304, 5]])), 0);
  assert.equal(map.totalVisited(), 0);
  assert.equal(map.version, v);
  assert.equal(map.latLngBounds(), null, "an ignored cell does not stretch the bounds");
}
{ // the world's corner cells and the last cell of a block, tile and world are kept, each on its own bit
  const map = new FogMap();
  const W = 4194304;
  const corners = [[0, 0], [W - 1, 0], [0, W - 1], [W - 1, W - 1], cellOf(3, 3, 0, 0, 63, 0), cellOf(3, 3, 0, 0, 0, 63), cellOf(3, 3, 127, 127, 63, 63)];
  assert.equal(map.addCells(pairs(corners)), corners.length);
  for (const [cx, cy] of corners) assert.equal(map.isVisitedCell(cx, cy), true, `${cx},${cy}`);
  const [lx, ly] = cellOf(3, 3, 127, 127, 63, 63);
  assert.equal(map.isVisitedCell(lx + 1, ly), false, "the next tile over");
  assert.equal(map.isVisitedCell(lx - 1, ly), false);
  assert.equal(map.countVisitedInCellRect(0, 0, W, W), corners.length);
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
{ // a rect across two blocks and across two tiles counts imported and overlay cells on each side
  const map = new FogMap();
  map.addTile(nameOf(idOf(5, 6)), tileBytes([{ bx: 127, by: 0, cells: [[62, 0], [63, 0]] }, { bx: 126, by: 0, cells: [[63, 0]] }]));
  map.addCells(pairs([cellOf(6, 6, 0, 0, 0, 0), cellOf(6, 6, 0, 0, 1, 0), cellOf(5, 6, 126, 0, 62, 0)]));
  const [x, y] = cellOf(5, 6, 127, 0, 63, 0);
  const rect = (x0, x1) => map.countVisitedInCellRect(x0, y, x1, y + 1);
  assert.equal(rect(x, x + 2), 2, "the last cell of tile 5 and the first of tile 6");
  assert.equal(rect(x - 1, x + 3), 4, "two cells each side of the tile edge");
  assert.equal(rect(x - 65, x - 63), 2, "the last two cells of the block before, one overlay, one imported");
  assert.equal(rect(x - 64, x - 62), 1, "across the block edge: the imported cell before it, nothing after");
  assert.equal(rect(x - 66, x + 3), 6);
}
{ // a tile whose header points past its data is refused, naming the tile, and the map stays as it was
  const map = new FogMap();
  const good = tileBytes([{ bx: 0, by: 0, cells: [[0, 0]] }, { bx: 1, by: 0, cells: [[0, 0]] }]);
  const pastBlocks = good.slice();
  new DataView(pastBlocks.buffer).setUint16(2, 3, true);
  for (const [label, data] of [
    ["shorter than the header", good.subarray(0, HEADER - 2)],
    ["last block cut short", good.subarray(0, good.length - 1)],
    ["header index past the blocks", pastBlocks],
  ]) {
    assert.throws(() => map.addTile(nameOf(idOf(7, 8)), data), (e) => e instanceof Error && e.message.includes(String(idOf(7, 8))), label);
    assert.equal(map.tileCount, 0, label);
    assert.equal(map.tiles.size, 0, label);
    assert.equal(map.version, 0, label);
  }
  assert.equal(map.addTile(nameOf(idOf(7, 8)), good), true);
  const trailing = new Uint8Array(good.length + 7);
  trailing.set(good);
  assert.equal(map.addTile(nameOf(idOf(7, 9)), trailing), true, "bytes after the last block are not an error");
}
{ // the same tile loaded twice is one tile: the second copy replaces the first
  const map = new FogMap();
  map.addTile(nameOf(idOf(1, 1)), tileBytes([{ bx: 0, by: 0, cells: [[0, 0]] }]));
  map.addTile(nameOf(idOf(1, 1)), tileBytes([{ bx: 0, by: 0, cells: [[0, 0], [1, 0]] }]));
  assert.equal(map.tileCount, 1);
  assert.equal(map.totalVisited(), 2);
}
{ // addTile moves the version too
  const map = new FogMap();
  const v = map.version;
  map.addTile(nameOf(idOf(1, 1)), tileBytes([{ bx: 0, by: 0, cells: [[0, 0]] }]));
  assert.ok(map.version > v);
}
{ // an import that lands after overlay cells covers some of them: counted once everywhere, merged into one block
  const map = new FogMap();
  const a = cellOf(5, 6, 1, 2, 3, 4), b = cellOf(5, 6, 1, 2, 4, 4), c = cellOf(5, 6, 1, 2, 63, 63);
  map.addCells(pairs([a, b, c]));
  assert.equal(map.totalVisited(), 3);
  const v = map.version;
  map.addTile(nameOf(idOf(5, 6)), tileBytes([{ bx: 1, by: 2, cells: [[3, 4], [10, 10]], extra: [0x23, 0xc0, 0x05] }]));
  assert.ok(map.version > v);
  assert.equal(map.totalVisited(), 4, "the cached total refreshes; a is counted once");
  const rect = (x0, y0, x1, y1) => map.countVisitedInCellRect(x0, y0, x1, y1);
  const [bx0, by0] = cellOf(5, 6, 1, 2, 0, 0);
  assert.equal(rect(0, 0, 4194304, 4194304), 4);
  assert.equal(rect(bx0, by0, bx0 + 64, by0 + 64), 4, "whole-block rect");
  assert.equal(rect(a[0], a[1], a[0] + 1, a[1] + 1), 1, "partial rect on the doubly covered cell");
  assert.equal(rect(a[0], a[1], b[0] + 1, b[1] + 1), 2, "partial rect over a and b");
  assert.equal(rect(bx0 + 5, by0, bx0 + 64, by0 + 64), 2, "rect starting mid-block drops a and b, keeps c and the imported cell");
  for (const [cx, cy] of [a, b, c]) assert.equal(map.isVisitedCell(cx, cy), true);
  const got = Array.from(map.blocks());
  assert.equal(got.length, 1);
  sameBytes(got[0].extra, [0x23, 0xc0, 0x05]);
  assert.equal(got[0].bitmap.reduce((n, v) => n + v.toString(2).replace(/0/g, "").length, 0), 4);
}
console.log("fog-map.test.js ok");
