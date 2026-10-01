import { expect, it } from "vitest";
import {
  largeBackup,
  notABackup,
  STANDARD_TILE_COUNT,
  standardBackup,
  tileFilename,
} from "../fixtures/make-backup.js";
import { loadUpstream, loadZipLikeDefog } from "../support/loadUpstream.js";

const up = loadUpstream();

it("names tiles the way the parser reads them", () => {
  expect(tileFilename(257, 256)).toBe("testlwlwhizz");
  expect(up.parseTileId(tileFilename(257, 256))).toBe(131329);
  expect(up.parseTileId(tileFilename(256, 256))).toBe(131328);
});

it("RF4: the standard backup loads two tiles despite its extra entries", () => {
  expect(up.unzip(standardBackup())).toHaveLength(5);
  const { tiles, fogMap } = loadZipLikeDefog(standardBackup());
  expect(tiles).toBe(STANDARD_TILE_COUNT);
  expect(fogMap.isVisitedCell(256 * 8192, 256 * 8192)).toBe(true);
  expect(fogMap.isVisitedCell(256 * 8192 + 127, 256 * 8192 + 127)).toBe(true);
  expect(fogMap.isVisitedCell(256 * 8192 + 128, 256 * 8192)).toBe(false);
});

it("not-a-backup unzips but holds no tiles", () =>
  expect(loadZipLikeDefog(notABackup()).tiles).toBe(0));

it("is deterministic", () => expect(standardBackup()).toEqual(standardBackup()));

it("builds a large backup of about the requested size", () => {
  const zip = largeBackup(5_000_000, 7);
  expect(zip.length).toBeGreaterThanOrEqual(5_000_000);
  expect(zip.length).toBeLessThan(5_100_000);
  expect(loadZipLikeDefog(zip).tiles).toBeGreaterThan(0);
  expect(largeBackup(5_000_000, 7)).toEqual(zip);
});
