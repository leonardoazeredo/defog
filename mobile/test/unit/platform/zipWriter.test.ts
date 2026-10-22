import { expect, it } from "vitest";
import { writeZip } from "../../../src/platform/zipWriter.js";
import { loadUpstream, loadZipLikeDefog } from "../../support/loadUpstream.js";

const bytes = (...n: number[]) => Uint8Array.from(n);

it("round-trips two entries through the page's unzip with names, bytes and order", () => {
  const entries = [
    { name: "Sync/b", bytes: bytes(1, 2, 3, 4) },
    { name: "Sync/a", bytes: bytes(255, 0, 255) },
  ];
  const out = loadUpstream().unzip(writeZip(entries));
  expect(out.map((e) => e.name)).toEqual(["Sync/b", "Sync/a"]);
  expect(out.map((e) => [...e.data])).toEqual([
    [1, 2, 3, 4],
    [255, 0, 255],
  ]);
});

it("writes a valid zip with no entries", () => {
  const zip = writeZip([]);
  expect(zip.length).toBe(22);
  expect(loadUpstream().unzip(zip)).toEqual([]);
});

it("keeps an empty file and a name outside ASCII", () => {
  const out = loadUpstream().unzip(
    writeZip([
      { name: "Sync/empty", bytes: new Uint8Array(0) },
      { name: "Sync/é", bytes: bytes(9) },
    ]),
  );
  expect(out.map((e) => e.name)).toEqual(["Sync/empty", "Sync/é"]);
  expect(out[0]?.data.length).toBe(0);
});

it("stores the CRC-32 of each entry", () => {
  // "123456789" is the standard CRC-32 check input.
  const zip = writeZip([{ name: "c", bytes: new TextEncoder().encode("123456789") }]);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  expect(dv.getUint32(14, true)).toBe(0xcbf43926);
});

it("stores a fixed date so the file says nothing about when it was made", () => {
  const dv = (z: Uint8Array) => new DataView(z.buffer, z.byteOffset, z.byteLength);
  const zip = writeZip([{ name: "a", bytes: bytes(1) }]);
  expect(dv(zip).getUint16(10, true)).toBe(0);
  expect(dv(zip).getUint16(12, true)).toBe(0x21);
});

it("refuses more entries than a zip without ZIP64 holds", () => {
  const many = Array.from({ length: 65_536 }, (_, i) => ({
    name: `n${i}`,
    bytes: new Uint8Array(0),
  }));
  expect(() => writeZip(many)).toThrow(/ZIP64/);
});

it("zips a Fog of World export that re-imports to the same fog", () => {
  const up = loadUpstream();
  // Cells in two different tiles, so the export holds two files.
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < 40; i++) cells.push([2000 + i, 3000 + (i % 7)], [60_000 + i, 90_000 + i]);
  const original = up.newFogMap();
  original.addCells(Int32Array.from(cells.flat()));

  const files = up.writeSync(original);
  expect(files.length).toBe(2);
  const zip = writeZip(files.map((f) => ({ name: `Sync/${f.name}`, bytes: f.bytes })));
  const { tiles, fogMap } = loadZipLikeDefog(zip);

  expect(tiles).toBe(2);
  for (const [cx, cy] of cells) expect(fogMap.isVisitedCell(cx, cy)).toBe(true);
  expect(fogMap.isVisitedCell(2000, 3010)).toBe(false);
  expect(fogMap.totalVisited()).toBe(original.totalVisited());
});
