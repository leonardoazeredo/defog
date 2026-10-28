// Fog of World Sync writer: a FogMap -> one zlib-compressed file per tile, in the format parser.js reads.
// Imported blocks keep the 10 region bits they came with; blocks the app created carry region 0.
// Empty blocks and tiles are never written.
(function (global) {
  const { FogMap, parseTileId, MAP_WIDTH, FORMAT } = global.FogParser;
  const { FILENAME_MASK1, TILE_WIDTH, TILE_HEADER_SIZE, BLOCK_BITMAP_SIZE, BLOCK_SIZE, blockKey, popcount } = FORMAT;
  const FILENAME_MASK2 = "eizxdwknmo";
  // pako at level 5 reproduces Fog of World's files byte for byte; Node's zlib at level 5 does not (bench/fog-writer.test.js)
  const DEFLATE_LEVEL = 5;

  const mapDigits = (digits, mask) => Array.from(digits, (d) => mask[d]).join("");

  function tileName(id) {
    if (!Number.isInteger(id) || id < 0 || id >= MAP_WIDTH * MAP_WIDTH) throw new RangeError("not a tile id: " + id);
    const digits = String(id);
    return MD5.hex(digits).slice(0, 4) + mapDigits(digits, FILENAME_MASK1) + mapDigits(digits.slice(-2), FILENAME_MASK2);
  }

  // The 3 extra bytes as a big-endian 24-bit value: region in the top 10 bits, 2*popcount+1 in the low 14.
  function extraBytes(bitmap, extra) {
    const region = extra ? ((extra[0] << 16) | (extra[1] << 8) | extra[2]) & 0xffc000 : 0;
    const e = region | (2 * popcount(bitmap) + 1);
    return [e >> 16, (e >> 8) & 255, e & 255];
  }

  const inTile = (v) => Number.isInteger(v) && v >= 0 && v < TILE_WIDTH;

  // blocks: [{bx, by, bitmap: 512 bytes, extra: 3 bytes | null}]. Returns the decompressed tile: the header with
  // 1-based indexes in header order, then the 515-byte blocks in that order. A block the format cannot hold (a
  // bitmap that is not 512 bytes, a position outside the tile, extra bytes that are not 3, a position given twice)
  // throws a RangeError.
  function writeTile(blocks) {
    const seen = new Set();
    for (const b of blocks) {
      if (!b.bitmap || b.bitmap.length !== BLOCK_BITMAP_SIZE) throw new RangeError(`block ${b.bx},${b.by}: bitmap is not ${BLOCK_BITMAP_SIZE} bytes`);
      if (!inTile(b.bx) || !inTile(b.by)) throw new RangeError(`block ${b.bx},${b.by}: outside the tile`);
      if (b.extra != null && b.extra.length !== 3) throw new RangeError(`block ${b.bx},${b.by}: extra is not 3 bytes`);
      const key = blockKey(b.bx, b.by);
      if (seen.has(key)) throw new RangeError(`block ${b.bx},${b.by}: given twice`);
      seen.add(key);
    }
    const kept = blocks.filter((b) => b.bitmap.some((v) => v !== 0)).sort((a, b) => blockKey(a.bx, a.by) - blockKey(b.bx, b.by));
    const out = new Uint8Array(TILE_HEADER_SIZE + kept.length * BLOCK_SIZE);
    const dv = new DataView(out.buffer);
    kept.forEach((b, i) => {
      dv.setUint16(blockKey(b.bx, b.by) * 2, i + 1, true);
      const at = TILE_HEADER_SIZE + i * BLOCK_SIZE;
      out.set(b.bitmap, at);
      out.set(extraBytes(b.bitmap, b.extra), at + BLOCK_BITMAP_SIZE);
    });
    return out;
  }

  const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  // The file as a reader would see it: it inflates to the tile written, its name reads back as its id, and the
  // tile parses with a correct checksum on every block. Anything else would reach Fog of World as a damaged tile.
  function verify(file, id, raw, inflate) {
    let back;
    try { back = inflate(file.bytes); } catch (e) { throw new Error(`tile ${id}: the written file does not inflate`, { cause: e }); }
    if (!back || !sameBytes(back, raw)) throw new Error(`tile ${id}: the written file inflates to other bytes`);
    if (parseTileId(file.name) !== id) throw new Error(`tile ${id}: its file name reads back as another tile`);
    const map = new FogMap();
    map.addTile(file.name, raw);
    for (const b of map.blocks()) {
      const e = (b.extra[0] << 16) | (b.extra[1] << 8) | b.extra[2];
      if ((e & 0x3fff) !== 2 * popcount(b.bitmap) + 1) throw new Error(`tile ${id}: block ${b.bx},${b.by} has a bad checksum`);
    }
  }

  // `deflate` defaults to the pako build the page loads (see pakoDeflate.js) and `inflate`, which reads every file
  // back before it is handed out, to the inflate build left in window.pako; `opts` overrides either. Throws on a file
  // that does not read back, so a broken export is never saved.
  function writeSync(fogMap, opts) {
    let deflate = opts && opts.deflate;
    if (!deflate) {
      if (!global.pakoDeflate || typeof global.pakoDeflate.deflate !== "function") {
        throw new Error("writeSync needs a deflate function or the pako deflate build (vendor/pako_deflate.min.js, then src/pakoDeflate.js, before pako_inflate.min.js)");
      }
      deflate = (buf) => global.pakoDeflate.deflate(buf, { level: DEFLATE_LEVEL });
    }
    let inflate = opts && opts.inflate;
    if (!inflate) {
      if (!global.pako || typeof global.pako.inflate !== "function") {
        throw new Error("writeSync needs an inflate function or the pako inflate build (vendor/pako_inflate.min.js) to check what it wrote");
      }
      inflate = (buf) => global.pako.inflate(buf);
    }
    const files = [];
    let tid = -1, blocks = [];
    const flush = () => {
      if (blocks.length === 0) return;
      const raw = writeTile(blocks);
      const bytes = deflate(raw);
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error(`deflate returned no bytes for tile ${tid}`);
      const file = { name: tileName(tid), bytes };
      verify(file, tid, raw, inflate);
      files.push(file);
    };
    // blocks() yields each tile contiguously, so a change of tile id ends a file
    for (const b of fogMap.blocks()) {
      const id = b.ty * MAP_WIDTH + b.tx;
      if (id !== tid) { flush(); tid = id; blocks = []; }
      blocks.push(b);
    }
    flush();
    return files;
  }

  global.FogWriter = { tileName, writeTile, writeSync };
})(window);
