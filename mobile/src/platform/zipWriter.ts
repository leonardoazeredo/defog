export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

// 0xffff in the end record means "see the ZIP64 record", so it is not a valid count here.
export const MAX_ENTRIES = 0xfffe;
const MAX_SIZE = 0xffffffff;
// 1980-01-01 00:00: the format needs a date, and an export should not say when it was made.
const DOS_TIME = 0;
const DOS_DATE = 0x21;
// Bit 11: names are UTF-8.
const FLAG_UTF8 = 0x0800;
const VERSION = 20;
// Fixed sizes of the local header, the central header and the end record; the first two are followed by the entry name.
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

// An unzip joins each name to the folder it extracts into, so an empty name, a leading `/`, a `.` or `..`
// segment, or the same name twice could write outside that folder or over another entry.
function checkNames(entries: readonly ZipEntry[]): void {
  const seen = new Set<string>();
  for (const { name } of entries) {
    const parts = name.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..") || seen.has(name)) {
      throw new Error("zip entry name not allowed");
    }
    seen.add(name);
  }
}

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

/**
 * A zip with every entry stored, not compressed: Fog of World tiles are deflated already. No ZIP64, so it throws
 * past MAX_ENTRIES entries or 4 GiB, and for a name that is empty, has an empty, `.` or `..` segment, repeats or
 * runs past 65535 bytes.
 */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new Error("too many entries for a zip without ZIP64");
  checkNames(entries);
  const encoder = new TextEncoder();
  const parts = entries.map((e) => ({
    name: encoder.encode(e.name),
    bytes: e.bytes,
    crc: crc32(e.bytes),
  }));

  let total = END_RECORD;
  for (const p of parts) {
    if (p.name.length > 0xffff) throw new Error("zip entry name too long");
    total += LOCAL_HEADER + CENTRAL_HEADER + 2 * p.name.length + p.bytes.length;
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
    out.set(p.name, pos + LOCAL_HEADER);
    out.set(p.bytes, pos + LOCAL_HEADER + p.name.length);
    pos += LOCAL_HEADER + p.name.length + p.bytes.length;
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
    out.set(p.name, pos + CENTRAL_HEADER);
    pos += CENTRAL_HEADER + p.name.length;
  });

  dv.setUint32(pos, 0x06054b50, true);
  dv.setUint16(pos + 8, parts.length, true);
  dv.setUint16(pos + 10, parts.length, true);
  dv.setUint32(pos + 12, pos - directoryStart, true);
  dv.setUint32(pos + 16, directoryStart, true);
  return out;
}
