// Fog of World sync-data parser (browser port of CaviarChen/Fog-of-World-Data-Parser).
//
// Format recap:
//   Sync/ holds one file per TILE. World = 512x512 tiles (Web Mercator).
//   Filename: md5(id)[0:4] + base10(id) encoded via MASK1 + mask2(id[-2:]).
//   Each file is zlib-compressed. Decompressed:
//     - header: 128*128 uint16 (little-endian) mapping block position -> 1-based block index (0 = absent)
//     - then blocks, each 515 bytes: 512-byte bitmap (64x64 bits) + 3 bytes extra (region + checksum)
//   A set bit = a defogged cell. Grid is 512 tiles * (128 blocks * 64 bits) = 2^22 cells per axis.
//   The 3 extra bytes hold 10 region bits and the checksum 2*popcount+1; the writer (fogWriter.js) needs the region bits
//   back, so Tile hands them out. Cells added by the app live in a per-FogMap overlay beside the imported tiles.
(function (global) {
  const FILENAME_MASK1 = "olhwjsktri";
  const MAP_WIDTH = 512;
  const TILE_WIDTH = 128;
  const TILE_HEADER_LEN = TILE_WIDTH * TILE_WIDTH;   // 16384
  const TILE_HEADER_SIZE = TILE_HEADER_LEN * 2;      // 32768 bytes
  const BLOCK_BITMAP_SIZE = 512;
  const BLOCK_SIZE = 515;
  const BITMAP_WIDTH = 64;
  const BITS_PER_TILE_EDGE = TILE_WIDTH * BITMAP_WIDTH; // 8192 = 2^13
  const WORLD_CELLS = MAP_WIDTH * BITS_PER_TILE_EDGE;   // 4194304 = 2^22

  // Set-bits-per-byte lookup, for popcounting bitmaps quickly.
  const POPCNT = new Uint8Array(256);
  for (let i = 0; i < 256; i++) POPCNT[i] = (i & 1) + POPCNT[i >> 1];

  function parseTileId(filename) {
    const core = filename.slice(4, -2);
    let id = 0;
    for (const ch of core) {
      const v = FILENAME_MASK1.indexOf(ch);
      if (v < 0) return null;
      id = id * 10 + v;
    }
    return id;
  }

  class Tile {
    constructor(id, data) {
      this.id = id;
      this.x = id % MAP_WIDTH;
      this.y = Math.floor(id / MAP_WIDTH);
      this.data = data;
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      this.header = new Uint16Array(TILE_HEADER_LEN);
      for (let i = 0; i < TILE_HEADER_LEN; i++) this.header[i] = dv.getUint16(i * 2, true);
    }
    // blockX,blockY in 0..127 ; bitX,bitY in 0..63
    isVisited(blockX, blockY, bitX, bitY) {
      const idx = this.header[blockY * TILE_WIDTH + blockX];
      if (idx === 0) return false;
      const start = TILE_HEADER_SIZE + (idx - 1) * BLOCK_SIZE;
      const byte = this.data[start + (bitX >> 3) + bitY * 8];
      return (byte & (1 << (7 - (bitX & 7)))) !== 0;
    }

    // idx is the header's 1-based block index; a view onto the 3 bytes after that block's bitmap.
    blockExtra(idx) {
      const at = TILE_HEADER_SIZE + (idx - 1) * BLOCK_SIZE + BLOCK_BITMAP_SIZE;
      return this.data.subarray(at, at + 3);
    }

    // The block's 512-byte bitmap (a view), or null when the tile has no such block.
    blockBitmap(blockX, blockY) {
      const idx = this.header[blockY * TILE_WIDTH + blockX];
      if (idx === 0) return null;
      const at = TILE_HEADER_SIZE + (idx - 1) * BLOCK_SIZE;
      return this.data.subarray(at, at + BLOCK_BITMAP_SIZE);
    }

    // Present blocks in header order (by*128+bx), which is not always the order they are stored in.
    *blocks() {
      for (let k = 0; k < TILE_HEADER_LEN; k++) {
        const idx = this.header[k];
        if (idx === 0) continue;
        const at = TILE_HEADER_SIZE + (idx - 1) * BLOCK_SIZE;
        yield { bx: k % TILE_WIDTH, by: k >> 7, bitmap: this.data.subarray(at, at + BLOCK_BITMAP_SIZE), extra: this.blockExtra(idx) };
      }
    }

    // Total defogged cells in the whole tile (popcount every present block), cached.
    totalVisited() {
      if (this._tv != null) return this._tv;
      let c = 0;
      for (let i = 0; i < TILE_HEADER_LEN; i++) {
        const idx = this.header[i];
        if (idx === 0) continue;
        const start = TILE_HEADER_SIZE + (idx - 1) * BLOCK_SIZE;
        for (let k = 0; k < BLOCK_BITMAP_SIZE; k++) c += POPCNT[this.data[start + k]];
      }
      return (this._tv = c);
    }

    // Count defogged cells in local cell rect [lx0,lx1) x [ly0,ly1), clamped to the tile.
    countVisited(lx0, ly0, lx1, ly1) {
      lx0 = Math.max(0, lx0); ly0 = Math.max(0, ly0);
      lx1 = Math.min(BITS_PER_TILE_EDGE, lx1); ly1 = Math.min(BITS_PER_TILE_EDGE, ly1);
      if (lx1 <= lx0 || ly1 <= ly0) return 0;
      if (lx0 === 0 && ly0 === 0 && lx1 === BITS_PER_TILE_EDGE && ly1 === BITS_PER_TILE_EDGE) return this.totalVisited();
      const bx0 = lx0 >> 6, bx1 = (lx1 - 1) >> 6, by0 = ly0 >> 6, by1 = (ly1 - 1) >> 6;
      let count = 0;
      for (let by = by0; by <= by1; by++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          const idx = this.header[by * TILE_WIDTH + bx];
          if (idx === 0) continue;
          const start = TILE_HEADER_SIZE + (idx - 1) * BLOCK_SIZE;
          const cbx = bx << 6, cby = by << 6;
          const x0 = Math.max(lx0, cbx) - cbx, x1 = Math.min(lx1, cbx + 64) - cbx;
          const y0 = Math.max(ly0, cby) - cby, y1 = Math.min(ly1, cby + 64) - cby;
          if (x0 === 0 && x1 === 64) {
            for (let bitY = y0; bitY < y1; bitY++) { const r = start + bitY * 8; for (let k = 0; k < 8; k++) count += POPCNT[this.data[r + k]]; }
          } else {
            for (let bitY = y0; bitY < y1; bitY++) {
              const r = start + bitY * 8;
              for (let bitX = x0; bitX < x1; bitX++) if (this.data[r + (bitX >> 3)] & (1 << (7 - (bitX & 7)))) count++;
            }
          }
        }
      }
      return count;
    }
  }

  // Set bits of `bitmap` that `masked` (an imported bitmap, or null) does not already have, inside the local
  // cell rect [x0,x1) x [y0,y1) of one 64x64 block.
  function countNewBits(bitmap, masked, x0, y0, x1, y1) {
    let count = 0;
    for (let y = y0; y < y1; y++) {
      const row = y * 8;
      if (x0 === 0 && x1 === 64) {
        for (let k = 0; k < 8; k++) count += POPCNT[masked ? bitmap[row + k] & ~masked[row + k] : bitmap[row + k]];
      } else {
        for (let x = x0; x < x1; x++) {
          const bit = 1 << (7 - (x & 7));
          if ((bitmap[row + (x >> 3)] & bit) && !(masked && (masked[row + (x >> 3)] & bit))) count++;
        }
      }
    }
    return count;
  }

  class FogMap {
    constructor() {
      this.tiles = new Map();
      this.tileCount = 0;
      this.bounds = null; // {minX,minY,maxX,maxY} in tile-grid units
      // cells added by the app, Map<tileId, Map<by*128+bx, Uint8Array(512)>>; addCells skips cells the import covers, but a later addTile can cover overlay cells, so readers OR the two (see blocks())
      this.overlay = new Map();
      // bumped by every addTile, addCells and clearOverlay so caches built on the fog can tell it moved
      this.version = 0;
      this._total = null;
    }
    _key(tx, ty) { return ty * MAP_WIDTH + tx; }

    _extendBounds(tx, ty) {
      const b = this.bounds || { minX: tx, minY: ty, maxX: tx, maxY: ty };
      b.minX = Math.min(b.minX, tx); b.minY = Math.min(b.minY, ty);
      b.maxX = Math.max(b.maxX, tx); b.maxY = Math.max(b.maxY, ty);
      this.bounds = b;
    }

    addTile(filename, decompressed) {
      const id = parseTileId(filename);
      if (id === null) return false;
      const t = new Tile(id, decompressed);
      this.tiles.set(this._key(t.x, t.y), t);
      this.tileCount++;
      this._extendBounds(t.x, t.y);
      this.version++;
      return true;
    }

    // cells: Int32Array of [cx, cy] pairs in global cell coords. Returns how many were new: a cell the import or
    // the overlay already covers, or one outside the world, is skipped.
    addCells(cells) {
      if (Object.prototype.toString.call(cells) !== "[object Int32Array]") throw new TypeError("addCells takes an Int32Array of [cx, cy] pairs");
      if (cells.length % 2 !== 0) throw new RangeError("addCells takes [cx, cy] pairs, got an odd length");
      let added = 0;
      for (let i = 0; i + 1 < cells.length; i += 2) {
        const cx = cells[i], cy = cells[i + 1];
        if (cx < 0 || cy < 0 || cx >= WORLD_CELLS || cy >= WORLD_CELLS) continue;
        if (this.isVisitedCell(cx, cy)) continue;
        const tx = cx >> 13, ty = cy >> 13;
        const tid = this._key(tx, ty);
        let blocks = this.overlay.get(tid);
        if (!blocks) { blocks = new Map(); this.overlay.set(tid, blocks); }
        const lx = cx & 8191, ly = cy & 8191;
        const key = (ly >> 6) * TILE_WIDTH + (lx >> 6);
        let bitmap = blocks.get(key);
        if (!bitmap) { bitmap = new Uint8Array(BLOCK_BITMAP_SIZE); blocks.set(key, bitmap); }
        bitmap[((lx & 63) >> 3) + (ly & 63) * 8] |= 1 << (7 - (lx & 7));
        this._extendBounds(tx, ty);
        added++;
      }
      this.version++;
      return added;
    }

    clearOverlay() {
      this.overlay = new Map();
      this.bounds = null;
      for (const t of this.tiles.values()) this._extendBounds(t.x, t.y);
      this.version++;
    }

    // global cell coords in [0, WORLD_CELLS)
    isVisitedCell(cx, cy) {
      if (cx < 0 || cy < 0 || cx >= WORLD_CELLS || cy >= WORLD_CELLS) return false;
      const tid = this._key(cx >> 13, cy >> 13);
      const lx = cx & 8191, ly = cy & 8191;
      const t = this.tiles.get(tid);
      if (t && t.isVisited(lx >> 6, ly >> 6, lx & 63, ly & 63)) return true;
      if (this.overlay.size === 0) return false;
      const bitmap = this.overlay.get(tid)?.get((ly >> 6) * TILE_WIDTH + (lx >> 6));
      return !!bitmap && (bitmap[((lx & 63) >> 3) + (ly & 63) * 8] & (1 << (7 - (lx & 7)))) !== 0;
    }

    // Every defogged cell, imported or overlay, counted once.
    totalVisited() {
      if (this._total && this._total.version === this.version) return this._total.value;
      let count = 0;
      for (const t of this.tiles.values()) count += t.totalVisited();
      for (const [tid, blocks] of this.overlay) count += this._overlayCount(tid, blocks, 0, 0, BITS_PER_TILE_EDGE, BITS_PER_TILE_EDGE);
      this._total = { version: this.version, value: count };
      return count;
    }

    // Overlay cells of one tile inside the local cell rect that the import does not already have.
    _overlayCount(tid, blocks, lx0, ly0, lx1, ly1) {
      const t = this.tiles.get(tid);
      let count = 0;
      for (const [key, bitmap] of blocks) {
        const bx = key % TILE_WIDTH, by = key >> 7;
        const cbx = bx << 6, cby = by << 6;
        const x0 = Math.max(lx0, cbx) - cbx, x1 = Math.min(lx1, cbx + 64) - cbx;
        const y0 = Math.max(ly0, cby) - cby, y1 = Math.min(ly1, cby + 64) - cby;
        if (x1 <= x0 || y1 <= y0) continue;
        count += countNewBits(bitmap, t ? t.blockBitmap(bx, by) : null, x0, y0, x1, y1);
      }
      return count;
    }

    // Count defogged cells whose global coords fall in [cx0,cx1) x [cy0,cy1).
    countVisitedInCellRect(cx0, cy0, cx1, cy1) {
      cx0 = Math.max(0, Math.floor(cx0)); cy0 = Math.max(0, Math.floor(cy0));
      cx1 = Math.min(WORLD_CELLS, Math.ceil(cx1)); cy1 = Math.min(WORLD_CELLS, Math.ceil(cy1));
      if (cx1 <= cx0 || cy1 <= cy0) return 0;
      const tx0 = cx0 >> 13, tx1 = (cx1 - 1) >> 13, ty0 = cy0 >> 13, ty1 = (cy1 - 1) >> 13;
      let count = 0;
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const tid = this._key(tx, ty);
          const t = this.tiles.get(tid);
          const baseX = tx << 13, baseY = ty << 13;
          if (t) count += t.countVisited(cx0 - baseX, cy0 - baseY, cx1 - baseX, cy1 - baseY);
          const blocks = this.overlay.size && this.overlay.get(tid);
          if (blocks) count += this._overlayCount(tid, blocks, cx0 - baseX, cy0 - baseY, cx1 - baseX, cy1 - baseY);
        }
      }
      return count;
    }

    // Every block with at least one defogged cell, tiles in ascending id and blocks in header order. An overlay
    // block that lands on an imported one is ORed into a copy and keeps the imported `extra`; a block only the
    // overlay has gets `extra: null`. Bitmaps of untouched imported blocks are views onto the tile data.
    *blocks() {
      const ids = new Set([...this.tiles.keys(), ...this.overlay.keys()]);
      for (const tid of Array.from(ids).sort((a, b) => a - b)) {
        const t = this.tiles.get(tid), over = this.overlay.get(tid);
        const merged = new Map();
        if (t) for (const b of t.blocks()) merged.set(b.by * TILE_WIDTH + b.bx, b);
        if (over) {
          for (const [key, bitmap] of over) {
            const imported = merged.get(key);
            const bitmapOut = new Uint8Array(bitmap);
            if (imported) for (let i = 0; i < BLOCK_BITMAP_SIZE; i++) bitmapOut[i] |= imported.bitmap[i];
            merged.set(key, { bx: key % TILE_WIDTH, by: key >> 7, bitmap: bitmapOut, extra: imported ? imported.extra : null });
          }
        }
        for (const key of Array.from(merged.keys()).sort((a, b) => a - b)) {
          const b = merged.get(key);
          if (!b.bitmap.some((v) => v !== 0)) continue;
          yield { tx: tid % MAP_WIDTH, ty: Math.floor(tid / MAP_WIDTH), bx: b.bx, by: b.by, bitmap: b.bitmap, extra: b.extra };
        }
      }
    }

    // Lat/lng bounding box of loaded data, as [[south,west],[north,east]].
    latLngBounds() {
      if (!this.bounds) return null;
      const b = this.bounds;
      const c1 = tileToLngLat(b.minX, b.minY);
      const c2 = tileToLngLat(b.maxX + 1, b.maxY + 1);
      return [[Math.min(c1.lat, c2.lat), Math.min(c1.lng, c2.lng)],
              [Math.max(c1.lat, c2.lat), Math.max(c1.lng, c2.lng)]];
    }
  }

  // x,y in 512-tile-grid units (fractional allowed)
  function tileToLngLat(x, y) {
    const lng = x / MAP_WIDTH * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / MAP_WIDTH)) * 180 / Math.PI;
    return { lng, lat };
  }

  // global fog-cell coords (fractional allowed) -> lng/lat
  function cellToLngLat(cx, cy) {
    return tileToLngLat(cx / BITS_PER_TILE_EDGE, cy / BITS_PER_TILE_EDGE);
  }

  // lng/lat -> global fog-cell coords (floats)
  function lngLatToCell(lng, lat) {
    const cx = (lng + 180) / 360 * WORLD_CELLS;
    const yTile = (Math.PI - Math.asinh(Math.tan(lat * Math.PI / 180))) / (2 * Math.PI) * MAP_WIDTH;
    const cy = yTile * BITS_PER_TILE_EDGE;
    return { cx, cy };
  }

  global.FogParser = {
    FogMap, parseTileId, tileToLngLat, cellToLngLat, lngLatToCell,
    WORLD_CELLS, MAP_WIDTH, BITS_PER_TILE_EDGE
  };
})(window);
