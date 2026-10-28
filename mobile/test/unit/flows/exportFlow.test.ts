import { describe, expect, it, vi } from "vitest";
import type { ExportChunk } from "../../../src/bridge/protocol.js";
import { COPY } from "../../../src/copy.js";
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

// Timers that run only when the test says so.
function fakeTimers() {
  let next = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    set(fn: () => void, ms: number) {
      const id = next++;
      pending.set(id, { fn, ms });
      return () => {
        pending.delete(id);
      };
    },
    fire() {
      const all = [...pending.values()];
      pending.clear();
      for (const t of all) t.fn();
      return all.map((t) => t.ms);
    },
    get count() {
      return pending.size;
    },
  };
}

function setup(save: "saved" | "cancelled" = "saved") {
  const fs = createMemoryExportFs();
  const timers = fakeTimers();
  const statuses: [string, string][] = [];
  const saved: Uint8Array[] = [];
  const saveAs = vi.fn(async (path: string, _name: string, _mime: string) => {
    saved.push(await fs.read(path.replace("/cache/", "")));
    return save === "saved" ? { name: "Saved.zip" } : null;
  });
  const notify = vi.fn();
  const flow = createExportFlow({
    fs,
    saveAs,
    notify,
    status: (exportId, state) => statuses.push([exportId, state]),
    setTimer: timers.set,
    now: () => new Date(2026, 9, 22, 12).getTime(),
  });
  return { fs, saveAs, notify, flow, saved, timers, statuses };
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

  it("drops the export when it sends more files than it declared", async () => {
    const { flow, fs, saveAs, notify } = setup();
    await flow.onChunk(chunk("aaaa", 0, 2, A, { files: 1 }));
    await flow.onChunk(chunk("bbbb", 0, 1, B, { files: 1 }));
    await flow.onChunk(chunk("aaaa", 1, 2, A, { files: 1 }));
    expect(saveAs).not.toHaveBeenCalled();
    expect(fs.files.size).toBe(0);
    expect(notify).toHaveBeenCalledExactlyOnceWith(COPY.fogExportFailed);
  });

  it("tells the user when a disagreement drops an export", async () => {
    const { flow, notify } = setup();
    await flow.onChunk(chunk("aaaa", 0, 1, A, { files: 2 }));
    await flow.onChunk(chunk("bbbb", 0, 1, B, { files: 3 }));
    expect(notify).toHaveBeenCalledExactlyOnceWith(COPY.fogExportFailed);
  });

  it("ignores a chunk that arrives after the export was saved", async () => {
    const { flow, fs, saveAs, notify } = setup();
    for (const c of CHUNKS) await flow.onChunk(c);
    notify.mockClear();
    await flow.onChunk(CHUNKS[0] as ExportChunk);
    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(fs.files.size).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("ignores the rest of an export that was dropped", async () => {
    const { flow, fs, saveAs, notify } = setup();
    await flow.onChunk(chunk("aaaa", 0, 3, A, { files: 2 }));
    await flow.onChunk(chunk("aaaa", 1, 2, A, { files: 2 }));
    notify.mockClear();
    for (const c of CHUNKS) await flow.onChunk(c);
    expect(saveAs).not.toHaveBeenCalled();
    expect(fs.files.size).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("cleans up, says so once without a path, and still serves the next export when a read fails", async () => {
    const { flow, fs, saveAs, notify } = setup();
    const read = fs.read.bind(fs);
    let failNext = true;
    fs.read = async (path) => {
      if (failNext && path.includes("/parts/")) {
        failNext = false;
        throw new Error("/data/user/0/secret/path");
      }
      return read(path);
    };
    for (const c of CHUNKS) await flow.onChunk(c);
    expect(saveAs).not.toHaveBeenCalled();
    expect(fs.files.size).toBe(0);
    expect(notify).toHaveBeenCalledExactlyOnceWith(COPY.fogExportFailed);

    for (const c of CHUNKS) await flow.onChunk({ ...c, exportId: "e2" });
    expect(saveAs).toHaveBeenCalledTimes(1);
  });

  it("does not report a failed export when only the cleanup after a save fails", async () => {
    const { flow, fs, notify } = setup();
    const remove = fs.remove.bind(fs);
    fs.remove = async (path) => {
      if (path === "export-e1") throw new Error("locked");
      return remove(path);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const c of CHUNKS) await flow.onChunk(c);
    warn.mockRestore();
    expect(notify).toHaveBeenCalledExactlyOnceWith(COPY.fogExportSaved("Saved.zip"));
  });

  it("never rejects from the startup sweep", async () => {
    const { flow, fs } = setup();
    fs.removeExportDirs = async () => {
      throw new Error("1 cache entries not removed");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(flow.clear()).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("removes what an earlier run left in the cache", async () => {
    const { flow, fs } = setup();
    fs.files.set("export-old/Sync/aaaa", A);
    fs.files.set("backup/keep", A);
    await flow.clear();
    expect([...fs.files.keys()]).toEqual(["backup/keep"]);
  });

  it("tells the page the picker is open, then that the export was saved", async () => {
    const { flow, statuses } = setup();
    for (const c of CHUNKS) await flow.onChunk(c);
    expect(statuses).toEqual([
      ["e1", "saving"],
      ["e1", "saved"],
    ]);
  });

  it("tells the page a cancelled picker saved nothing", async () => {
    const { flow, statuses } = setup("cancelled");
    for (const c of CHUNKS) await flow.onChunk(c);
    expect(statuses).toEqual([
      ["e1", "saving"],
      ["e1", "cancelled"],
    ]);
  });

  it("tells the page an export failed, once, when saving fails", async () => {
    const { flow, statuses, saveAs } = setup();
    saveAs.mockRejectedValueOnce(new Error("io"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const c of CHUNKS) await flow.onChunk(c);
    vi.restoreAllMocks();
    expect(statuses).toEqual([
      ["e1", "saving"],
      ["e1", "failed"],
    ]);
  });

  it("tells the page when a disagreement drops an export", async () => {
    const { flow, statuses } = setup();
    await flow.onChunk(chunk("aaaa", 0, 1, A, { files: 2 }));
    await flow.onChunk(chunk("bbbb", 0, 1, B, { files: 3 }));
    expect(statuses).toEqual([["e1", "failed"]]);
  });

  it("logs the stage a failure happened in, not only its class", async () => {
    const { flow, saveAs } = setup();
    saveAs.mockRejectedValueOnce(new TypeError("/data/user/0/secret"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const c of CHUNKS) await flow.onChunk(c);
    const lines = warn.mock.calls.map((c) => c.join(" "));
    warn.mockRestore();
    expect(lines).toEqual(["crossfog: export failed while saving TypeError"]);
  });

  it("drops an export whose chunks stop coming, removes its parts and says so", async () => {
    const { flow, fs, notify, statuses, timers, saveAs } = setup();
    await flow.onChunk(CHUNKS[0] as ExportChunk);
    await flow.onChunk(CHUNKS[1] as ExportChunk);
    expect(fs.files.size).toBeGreaterThan(0);
    expect(timers.fire()).toEqual([60_000]);
    await flow.onChunk(CHUNKS[2] as ExportChunk);
    await flow.onChunk(CHUNKS[3] as ExportChunk);
    expect(fs.files.size).toBe(0);
    expect(saveAs).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledExactlyOnceWith(COPY.fogExportFailed);
    expect(statuses).toEqual([["e1", "failed"]]);
  });

  it("does not expire an export whose last chunks are still queued", async () => {
    const { flow, saveAs, timers } = setup();
    await flow.onChunk(CHUNKS[0] as ExportChunk);
    const rest = CHUNKS.slice(1).map((c) => flow.onChunk(c));
    timers.fire();
    await Promise.all(rest);
    expect(saveAs).toHaveBeenCalledTimes(1);
  });

  it("keeps no expiry timer once an export is saved", async () => {
    const { flow, timers } = setup();
    for (const c of CHUNKS) await flow.onChunk(c);
    expect(timers.count).toBe(0);
  });

  it("abandons an export one of whose chunks the bridge dropped", async () => {
    const { flow, fs, notify, statuses, saveAs } = setup();
    await flow.onChunk(CHUNKS[0] as ExportChunk);
    await flow.abandon("e1");
    for (const c of CHUNKS.slice(1)) await flow.onChunk(c);
    await flow.abandon("e1");
    expect(saveAs).not.toHaveBeenCalled();
    expect(fs.files.size).toBe(0);
    expect(notify).toHaveBeenCalledExactlyOnceWith(COPY.fogExportFailed);
    expect(statuses).toEqual([["e1", "failed"]]);
  });

  it("abandons an export whose first chunk was the one dropped", async () => {
    const { flow, statuses, saveAs } = setup();
    await flow.abandon("e1");
    for (const c of CHUNKS) await flow.onChunk(c);
    expect(saveAs).not.toHaveBeenCalled();
    expect(statuses).toEqual([["e1", "failed"]]);
  });

  it("does nothing when a chunk of an export already saved is dropped", async () => {
    const { flow, notify, statuses } = setup();
    for (const c of CHUNKS) await flow.onChunk(c);
    notify.mockClear();
    await flow.abandon("e1");
    expect(notify).not.toHaveBeenCalled();
    expect(statuses.map((s) => s[1])).toEqual(["saving", "saved"]);
  });

  it("remembers a bounded number of finished exports", async () => {
    const { flow, saveAs } = setup();
    for (let i = 0; i < 300; i++) {
      await flow.onChunk(chunk("aaaa", 0, 1, A, { exportId: `x${i}`, files: 1 }));
    }
    // A recent id is still ignored. The oldest is forgotten, so a chunk of it arriving more than MAX_CLOSED exports late would
    // start it again; the bound is safe because a page never sends chunks of an export that far behind.
    await flow.onChunk(chunk("aaaa", 0, 1, A, { exportId: "x299", files: 1 }));
    expect(saveAs).toHaveBeenCalledTimes(300);
    await flow.onChunk(chunk("aaaa", 0, 1, A, { exportId: "x0", files: 1 }));
    expect(saveAs).toHaveBeenCalledTimes(301);
  });
});
