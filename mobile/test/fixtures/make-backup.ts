import { zlibSync } from "fflate";

export interface BlockSpec {
  bx: number;
  by: number;
  fill: number; // every bitmap byte = fill
}

export interface TileSpec {
  x: number;
  y: number;
  blocks: BlockSpec[];
}

const MASK = "olhwjsktri";
const DOS_DATE = 0x5c21; // 2026-01-01: (46<<9)|(1<<5)|1
const DOS_TIME = 0x0000; // 00:00:00

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tileFilename(x: number, y: number): string {
  const id = y * 512 + x;
  const digits = String(id)
    .split("")
    .map((d) => MASK[Number(d)])
    .join("");
  return `test${digits}zz`;
}

export function encodeTile(spec: TileSpec): Uint8Array {
  const raw = new Uint8Array(32768 + spec.blocks.length * 515);
  const dv = new DataView(raw.buffer);
  spec.blocks.forEach((b, i) => {
    dv.setUint16((b.by * 128 + b.bx) * 2, i + 1, true);
    raw.fill(b.fill, 32768 + i * 515, 32768 + i * 515 + 512);
    // trailing 3 bytes stay 0
  });
  return zlibSync(raw, { level: 0 });
}

interface ZipEntry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  localOffset: number;
}

export function makeBackup(tiles: TileSpec[], extras?: Record<string, Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [];

  for (const t of tiles) {
    const name = enc.encode(`Sync/${tileFilename(t.x, t.y)}`);
    const data = encodeTile(t);
    entries.push({ name, data, crc: crc32(data), localOffset: 0 });
  }

  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      entries.push({ name: enc.encode(k), data: v, crc: crc32(v), localOffset: 0 });
    }
  }

  let localSize = 0;
  for (const e of entries) {
    e.localOffset = localSize;
    localSize += 30 + e.name.length + e.data.length;
  }
  const cdOffset = localSize;
  const cdSize = entries.reduce((s, e) => s + 46 + e.name.length, 0);
  const buf = new Uint8Array(cdOffset + cdSize + 22);
  const dv = new DataView(buf.buffer);
  let p = 0;

  for (const e of entries) {
    dv.setUint32(p, 0x04034b50, true);
    p += 4;
    dv.setUint16(p, 20, true);
    p += 2;
    dv.setUint16(p, 0, true);
    p += 2;
    dv.setUint16(p, 0, true);
    p += 2; // method: stored
    dv.setUint16(p, DOS_TIME, true);
    p += 2;
    dv.setUint16(p, DOS_DATE, true);
    p += 2;
    dv.setUint32(p, e.crc, true);
    p += 4;
    dv.setUint32(p, e.data.length, true);
    p += 4;
    dv.setUint32(p, e.data.length, true);
    p += 4;
    dv.setUint16(p, e.name.length, true);
    p += 2;
    dv.setUint16(p, 0, true);
    p += 2; // extra len
    buf.set(e.name, p);
    p += e.name.length;
    buf.set(e.data, p);
    p += e.data.length;
  }

  for (const e of entries) {
    dv.setUint32(p, 0x02014b50, true);
    p += 4;
    dv.setUint16(p, 20, true);
    p += 2;
    dv.setUint16(p, 20, true);
    p += 2;
    dv.setUint16(p, 0, true);
    p += 2;
    dv.setUint16(p, 0, true);
    p += 2; // method: stored
    dv.setUint16(p, DOS_TIME, true);
    p += 2;
    dv.setUint16(p, DOS_DATE, true);
    p += 2;
    dv.setUint32(p, e.crc, true);
    p += 4;
    dv.setUint32(p, e.data.length, true);
    p += 4;
    dv.setUint32(p, e.data.length, true);
    p += 4;
    dv.setUint16(p, e.name.length, true);
    p += 2;
    dv.setUint16(p, 0, true);
    p += 2;
    dv.setUint16(p, 0, true);
    p += 2;
    dv.setUint16(p, 0, true);
    p += 2;
    dv.setUint16(p, 0, true);
    p += 2;
    dv.setUint32(p, 0, true);
    p += 4;
    dv.setUint32(p, e.localOffset, true);
    p += 4;
    buf.set(e.name, p);
    p += e.name.length;
  }

  // EOCD
  dv.setUint32(p, 0x06054b50, true);
  p += 4;
  dv.setUint16(p, 0, true);
  p += 2;
  dv.setUint16(p, 0, true);
  p += 2;
  dv.setUint16(p, entries.length, true);
  p += 2;
  dv.setUint16(p, entries.length, true);
  p += 2;
  dv.setUint32(p, cdSize, true);
  p += 4;
  dv.setUint32(p, cdOffset, true);
  p += 4;
  dv.setUint16(p, 0, true);
  p += 2;

  return buf;
}

const NOT_A_TILE = new TextEncoder().encode("not a tile");

export const STANDARD_TILES: TileSpec[] = [
  {
    x: 256,
    y: 256,
    blocks: [
      { bx: 0, by: 0, fill: 0xff },
      { bx: 1, by: 0, fill: 0xff },
      { bx: 0, by: 1, fill: 0xff },
      { bx: 1, by: 1, fill: 0xff },
    ],
  },
  {
    x: 257,
    y: 256,
    blocks: [
      { bx: 0, by: 0, fill: 0xff },
      { bx: 1, by: 0, fill: 0xff },
      { bx: 0, by: 1, fill: 0xff },
      { bx: 1, by: 1, fill: 0xff },
    ],
  },
];

export const STANDARD_EXTRAS: Record<string, Uint8Array> = {
  "__MACOSX/Sync/._testlwlwhizz": NOT_A_TILE,
  "Sync/.DS_Store": NOT_A_TILE,
  "Fog of World/Settings.plist": NOT_A_TILE,
};

export const STANDARD_TILE_COUNT = 2;

export function standardBackup(): Uint8Array {
  return makeBackup(STANDARD_TILES, STANDARD_EXTRAS);
}

export function notABackup(): Uint8Array {
  const enc = new TextEncoder();
  const data = enc.encode("not a backup");
  return makeBackup([], { "notes.txt": data });
}

export function largeBackup(targetBytes: number, seed = 0): Uint8Array {
  const rng = mulberry32(seed);
  const tiles: TileSpec[] = [];
  let zipSize = 22; // EOCD

  const startTile = (x: number, y: number) => {
    const nameLen = `Sync/${tileFilename(x, y)}`.length;
    // local header + CD entry overhead + initial zlib for raw=32768 (one stored block)
    zipSize += 30 + nameLen + 46 + nameLen + 32768 + 6 + 5;
  };

  let tileX = 0;
  let tileY = 0;
  let blocks: BlockSpec[] = [];
  let currentRaw = 32768;

  startTile(tileX, tileY);

  while (zipSize < targetBytes) {
    if (blocks.length >= 16384) {
      tiles.push({ x: tileX, y: tileY, blocks });
      tileX++;
      if (tileX >= 512) {
        tileX = 0;
        tileY++;
      }
      blocks = [];
      currentRaw = 32768;
      startTile(tileX, tileY);
    }

    const n = blocks.length;
    blocks.push({
      bx: n % 128,
      by: Math.floor(n / 128),
      fill: Math.floor(rng() * 256),
    });

    const oldRaw = currentRaw;
    currentRaw += 515;
    const delta = 515 + 5 * (Math.ceil(currentRaw / 65535) - Math.ceil(oldRaw / 65535));
    zipSize += delta;
  }

  tiles.push({ x: tileX, y: tileY, blocks });
  return makeBackup(tiles);
}
