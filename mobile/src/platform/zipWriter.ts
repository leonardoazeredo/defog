export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

// 0xffff in the end record means "see the ZIP64 record", so it is not a valid count here.
const MAX_ENTRIES = 0xfffe;
const MAX_SIZE = 0xffffffff;
// 1980-01-01 00:00: the format needs a date, and an export should not say when it was made.
const DOS_TIME = 0;
const DOS_DATE = 0x21;
// Bit 11: names are UTF-8.
const FLAG_UTF8 = 0x0800;
const VERSION = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip with every entry stored, not compressed: Fog of World tiles are deflated already. No ZIP64. */
export function writeZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new Error("too many entries for a zip without ZIP64");
  const encoder = new TextEncoder();
  const parts = entries.map((e) => ({
    name: encoder.encode(e.name),
    bytes: e.bytes,
    crc: crc32(e.bytes),
  }));

  let total = 22;
  for (const p of parts) {
    if (p.name.length > 0xffff) throw new Error("zip entry name too long");
    total += 30 + 46 + 2 * p.name.length + p.bytes.length;
  }
  if (total > MAX_SIZE) throw new Error("zip too large without ZIP64");

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let pos = 0;
  const offsets: number[] = [];

  for (const p of parts) {
    offsets.push(pos);
    dv.setUint32(pos, 0x04034b50, true);
    dv.setUint16(pos + 4, VERSION, true);
    dv.setUint16(pos + 6, FLAG_UTF8, true);
    dv.setUint16(pos + 8, 0, true);
    dv.setUint16(pos + 10, DOS_TIME, true);
    dv.setUint16(pos + 12, DOS_DATE, true);
    dv.setUint32(pos + 14, p.crc, true);
    dv.setUint32(pos + 18, p.bytes.length, true);
    dv.setUint32(pos + 22, p.bytes.length, true);
    dv.setUint16(pos + 26, p.name.length, true);
    dv.setUint16(pos + 28, 0, true);
    out.set(p.name, pos + 30);
    out.set(p.bytes, pos + 30 + p.name.length);
    pos += 30 + p.name.length + p.bytes.length;
  }

  const directoryStart = pos;
  parts.forEach((p, i) => {
    dv.setUint32(pos, 0x02014b50, true);
    dv.setUint16(pos + 4, VERSION, true);
    dv.setUint16(pos + 6, VERSION, true);
    dv.setUint16(pos + 8, FLAG_UTF8, true);
    dv.setUint16(pos + 10, 0, true);
    dv.setUint16(pos + 12, DOS_TIME, true);
    dv.setUint16(pos + 14, DOS_DATE, true);
    dv.setUint32(pos + 16, p.crc, true);
    dv.setUint32(pos + 20, p.bytes.length, true);
    dv.setUint32(pos + 24, p.bytes.length, true);
    dv.setUint16(pos + 28, p.name.length, true);
    dv.setUint32(pos + 42, offsets[i] as number, true);
    out.set(p.name, pos + 46);
    pos += 46 + p.name.length;
  });

  dv.setUint32(pos, 0x06054b50, true);
  dv.setUint16(pos + 8, parts.length, true);
  dv.setUint16(pos + 10, parts.length, true);
  dv.setUint32(pos + 12, pos - directoryStart, true);
  dv.setUint32(pos + 16, directoryStart, true);
  return out;
}
