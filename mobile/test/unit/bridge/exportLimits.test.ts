import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  EXPORT_CHUNK_BYTES,
  EXPORT_MAX_FILES,
  inspectWebToNative,
} from "../../../src/bridge/protocol.js";
import { MAX_ENTRIES } from "../../../src/platform/zipWriter.js";
import { loadUpstream } from "../../support/loadUpstream.js";

// The page cannot import the app's constants, so the limits each side keeps are compared here.
const here = dirname(fileURLToPath(import.meta.url));
const fowExport = (() => {
  const btoa = (s: string) => Buffer.from(s, "binary").toString("base64");
  const window: Record<string, unknown> = { btoa };
  const src = readFileSync(resolve(here, "../../../../app/src/fowExport.js"), "utf-8");
  vm.runInContext(src, vm.createContext({ window }));
  return window.FowExport as {
    CHUNK_BYTES: number;
    chunksOf(
      files: { name: string; bytes: Uint8Array }[],
      exportId: string,
    ): Record<string, unknown>[];
  };
})();

const passes = (chunk: Record<string, unknown>) =>
  inspectWebToNative(JSON.stringify({ v: 1, type: "exportBinary", ...chunk })).ok;

describe("the export limits on both sides of the bridge", () => {
  it("cuts chunks on the page at the size the bridge accepts", () => {
    expect(fowExport.CHUNK_BYTES).toBe(EXPORT_CHUNK_BYTES);
  });

  it("caps the files of one export at the entries a zip without ZIP64 holds", () => {
    expect(EXPORT_MAX_FILES).toBe(MAX_ENTRIES);
  });

  it("lets a full-size page chunk through and stops one byte more", () => {
    const [full] = fowExport.chunksOf(
      [{ name: "abcd", bytes: new Uint8Array(EXPORT_CHUNK_BYTES) }],
      "e-1",
    );
    expect(full && passes(full)).toBe(true);
    const over = { ...full, data: Buffer.alloc(EXPORT_CHUNK_BYTES + 1).toString("base64") };
    expect(passes(over)).toBe(false);
  });

  it("accepts the largest file count and refuses one more", () => {
    const base = { exportId: "e-1", name: "abcd", index: 0, total: 1, data: "" };
    expect(passes({ ...base, files: EXPORT_MAX_FILES })).toBe(true);
    expect(passes({ ...base, files: EXPORT_MAX_FILES + 1 })).toBe(false);
  });

  it("accepts the tile names Fog of World uses", () => {
    const base = { exportId: "e-1", index: 0, total: 1, files: 1, data: "" };
    for (const id of [0, 1, 511, 512 * 511 + 511, 131_071]) {
      expect(passes({ ...base, name: loadUpstream().tileName(id) })).toBe(true);
    }
  });
});
