import { describe, expect, it, vi } from "vitest";
import type { ExportChunk } from "../../../src/bridge/protocol.js";
import { createExportFlow } from "../../../src/flows/exportFlow.js";
import { loadUpstream } from "../../support/loadUpstream.js";
import { createMemoryExportFs } from "../../support/memoryExportFs.js";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const A = Uint8Array.from([1, 2, 3, 4, 5, 6]);
const B = Uint8Array.from([9, 8, 7]);

const chunk = (
  name: string,
  index: number,
  total: number,
  bytes: Uint8Array,
  over: Partial<ExportChunk> = {},
): ExportChunk => ({ exportId: "e1", name, index, total, files: 2, data: b64(bytes), ...over });

// File a in 3 chunks and file b in 1, interleaved.
const CHUNKS = [
  chunk("aaaa", 0, 3, A.slice(0, 2)),
  chunk("bbbb", 0, 1, B),
  chunk("aaaa", 2, 3, A.slice(4)),
  chunk("aaaa", 1, 3, A.slice(2, 4)),
];

function setup(save: "saved" | "cancelled" = "saved") {
  const fs = createMemoryExportFs();
  const saved: Uint8Array[] = [];
  const saveAs = vi.fn(async (path: string, _name: string, _mime: string) => {
    saved.push(await fs.read(path.replace("/cache/", "")));
    return save === "saved" ? { name: "Saved.zip" } : null;
  });
  const notify = vi.fn();
  const flow = createExportFlow({ fs, saveAs, notify, now: () => Date.UTC(2026, 9, 22, 12) });
  return { fs, saveAs, notify, flow, saved };
}

describe("the Fog of World export flow", () => {
  it("reassembles interleaved chunks into a zip with Sync/<name> for each file", async () => {
    const { flow, saved, saveAs, fs } = setup();
    for (const c of CHUNKS) await flow.onChunk(c);
    expect(saveAs).toHaveBeenCalledTimes(1);
    const entries = loadUpstream().unzip(saved[0] as Uint8Array);
    expect(entries.map((e) => e.name)).toEqual(["Sync/aaaa", "Sync/bbbb"]);
    expect([...(entries[0]?.data ?? [])]).toEqual([...A]);
    expect([...(entries[1]?.data ?? [])]).toEqual([...B]);
    expect(fs.files.size).toBe(0);
  });

  it("saves under a dated zip name", async () => {
    const { flow, saveAs } = setup();
    for (const c of CHUNKS) await flow.onChunk(c);
    expect(saveAs.mock.calls[0]?.slice(1)).toEqual([
      "fog-of-world-export-2026-10-22.zip",
      "application/zip",
    ]);
  });

  it("calls saveAs once when the last chunks of both files arrive together", async () => {
    const { flow, saveAs } = setup();
    await Promise.all([
      flow.onChunk(CHUNKS[0] as ExportChunk),
      flow.onChunk(CHUNKS[2] as ExportChunk),
      flow.onChunk(CHUNKS[3] as ExportChunk),
      flow.onChunk(CHUNKS[1] as ExportChunk),
    ]);
    expect(saveAs).toHaveBeenCalledTimes(1);
  });

  it("leaves no files when the picker is cancelled, and says nothing", async () => {
    const { flow, fs, notify } = setup("cancelled");
    for (const c of CHUNKS) await flow.onChunk(c);
    expect(fs.files.size).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves no files and says so when saving fails", async () => {
    const { flow, fs, notify, saveAs } = setup();
    saveAs.mockRejectedValueOnce(new Error("/data/user/0/secret/path 48.12345"));
    for (const c of CHUNKS) await flow.onChunk(c);
    expect(fs.files.size).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).not.toMatch(/secret|48\./);
  });

  it("takes a repeated chunk once", async () => {
    const { flow, saveAs, saved } = setup();
    for (const c of [CHUNKS[0], CHUNKS[0], ...CHUNKS.slice(1)] as ExportChunk[]) {
      await flow.onChunk(c);
    }
    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(loadUpstream().unzip(saved[0] as Uint8Array)).toHaveLength(2);
  });

  it("drops the export, with a message, when chunks disagree about the file count", async () => {
    const { flow, fs, saveAs, notify } = setup();
    await flow.onChunk(chunk("aaaa", 0, 1, A, { files: 2 }));
    await flow.onChunk(chunk("bbbb", 0, 1, B, { files: 3 }));
    expect(saveAs).not.toHaveBeenCalled();
    expect(fs.files.size).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("drops the export when chunks of one file disagree about the chunk count", async () => {
    const { flow, fs, saveAs } = setup();
    await flow.onChunk(chunk("aaaa", 0, 3, A));
    await flow.onChunk(chunk("aaaa", 1, 2, A));
    expect(saveAs).not.toHaveBeenCalled();
    expect(fs.files.size).toBe(0);
  });

  it("keeps two exports apart by export id", async () => {
    const { flow, saveAs } = setup();
    await flow.onChunk(chunk("aaaa", 0, 1, A, { exportId: "e1", files: 1 }));
    await flow.onChunk(chunk("aaaa", 0, 1, B, { exportId: "e2", files: 1 }));
    expect(saveAs).toHaveBeenCalledTimes(2);
  });

  it("handles a chunk that arrives during the startup sweep after the sweep", async () => {
    const { flow, fs, saveAs } = setup();
    fs.files.set("export-old/Sync/aaaa", A);
    const sweeping = flow.clear();
    const chunks = CHUNKS.map((c) => flow.onChunk(c));
    await Promise.all([sweeping, ...chunks]);
    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(fs.files.size).toBe(0);
  });

  it("removes what an earlier run left in the cache", async () => {
    const { flow, fs } = setup();
    fs.files.set("export-old/Sync/aaaa", A);
    fs.files.set("backup/keep", A);
    await flow.clear();
    expect([...fs.files.keys()]).toEqual(["backup/keep"]);
  });
});
