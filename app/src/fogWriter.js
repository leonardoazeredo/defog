// Fog of World Sync writer: a FogMap -> one zlib-compressed file per tile, in the format parser.js reads.
// Imported blocks keep the 10 region bits they came with; blocks the app created carry region 0.
// Empty blocks and tiles are never written.
(function (global) {
  const FILENAME_MASK1 = "olhwjsktri";
  const FILENAME_MASK2 = "eizxdwknmo";
  const MAP_WIDTH = 512;
  const TILE_HEADER_SIZE = 128 * 128 * 2;
  const BLOCK_BITMAP_SIZE = 512;
  const BLOCK_SIZE = 515;
  // pako at level 5 reproduces Fog of World's files byte for byte; Node's zlib at level 5 does not (bench/fog-writer.test.js)
  const DEFLATE_LEVEL = 5;

  const mapDigits = (digits, mask) => Array.from(digits, (d) => mask[d]).join("");

  function tileName(id) {
    const digits = String(id);
    return MD5.hex(digits).slice(0, 4) + mapDigits(digits, FILENAME_MASK1) + mapDigits(digits.slice(-2), FILENAME_MASK2);
  }

  const POPCNT = new Uint8Array(256);
  for (let i = 1; i < 256; i++) POPCNT[i] = (i & 1) + POPCNT[i >> 1];

  function popcount(bitmap) {
    let n = 0;
    for (let i = 0; i < bitmap.length; i++) n += POPCNT[bitmap[i]];
    return n;
  }

  // The 3 extra bytes as a big-endian 24-bit value: region in the top 10 bits, 2*popcount+1 in the low 14.
  function extraBytes(bitmap, extra) {
    const region = extra ? ((extra[0] << 16) | (extra[1] << 8) | extra[2]) & 0xffc000 : 0;
    const e = region | (2 * popcount(bitmap) + 1);
    return [e >> 16, (e >> 8) & 255, e & 255];
  }

  // blocks: [{bx, by, bitmap: 512 bytes, extra: 3 bytes | null}]. Returns the decompressed tile: the header with
  // 1-based indexes in header order, then the 515-byte blocks in that order.
  function writeTile(blocks) {
    const kept = blocks.filter((b) => b.bitmap.some((v) => v !== 0)).sort((a, b) => (a.by * 128 + a.bx) - (b.by * 128 + b.bx));
    const out = new Uint8Array(TILE_HEADER_SIZE + kept.length * BLOCK_SIZE);
    const dv = new DataView(out.buffer);
    kept.forEach((b, i) => {
      dv.setUint16((b.by * 128 + b.bx) * 2, i + 1, true);
      const at = TILE_HEADER_SIZE + i * BLOCK_SIZE;
      out.set(b.bitmap, at);
      out.set(extraBytes(b.bitmap, b.extra), at + BLOCK_BITMAP_SIZE);
    });
    return out;
  }

  // `deflate` defaults to the pako build the page loads (see pakoDeflate.js); `opts.deflate` overrides it; the tests pass pako level 5 explicitly.
  function writeSync(fogMap, opts) {
    let deflate = opts && opts.deflate;
    if (!deflate) {
      if (!global.pakoDeflate || typeof global.pakoDeflate.deflate !== "function") {
        throw new Error("writeSync needs a deflate function or the pako deflate build (vendor/pako_deflate.min.js, then src/pakoDeflate.js, before pako_inflate.min.js)");
      }
      deflate = (buf) => global.pakoDeflate.deflate(buf, { level: DEFLATE_LEVEL });
    }
    const files = [];
    let tid = -1, blocks = [];
    const flush = () => {
      if (blocks.length === 0) return;
      const bytes = deflate(writeTile(blocks));
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error(`deflate returned no bytes for tile ${tid}`);
      files.push({ name: tileName(tid), bytes });
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
