import { decodeBase64 } from "../bridge/base64.js";
import type { ExportChunk } from "../bridge/protocol.js";
import { COPY } from "../copy.js";
import { localDate } from "../localDate.js";
import { writeZip } from "../platform/zipWriter.js";

/** Files under the cache directory, by path relative to it; parents are created on write. */
export interface ExportFs {
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  /** Removes a file or a directory with everything in it; a path that is not there is fine. */
  remove(path: string): Promise<void>;
  /** Removes every top-level entry whose name starts with `prefix`. Tries every match, then rejects if any could not be removed. */
  removeMatching(prefix: string): Promise<void>;
  /** A file system path (no scheme) for a path inside the cache. */
  absolute(path: string): string;
}

export interface ExportFlowDeps {
  fs: ExportFs;
  /** Asks where to save, then streams the file there; null when the user backs out of the picker. */
  saveAs(path: string, name: string, mime: string): Promise<{ name: string } | null>;
  notify(text: string): void;
  now(): number;
}

export interface ExportFlow {
  /** Never rejects: a failure is reported to the user and drops that export. */
  onChunk(chunk: ExportChunk): Promise<void>;
  /** Called once at startup: removes the directories of exports that never finished. Never rejects. */
  clear(): Promise<void>;
}

const DIR_PREFIX = "export-";
const ZIP_MIME = "application/zip";

interface FileProgress {
  total: number;
  got: Set<number>;
  complete: boolean;
}

interface Export {
  files: number;
  progress: Map<string, FileProgress>;
}

function exportName(now: number): string {
  return `fog-of-world-export-${localDate(now)}.zip`;
}

export function createExportFlow(deps: ExportFlowDeps): ExportFlow {
  const open = new Map<string, Export>();
  // A chunk that arrives after its export finished or failed must not start a second one.
  const closed = new Set<string>();
  // Chunks are separate WebView messages that can interleave; handling them one at a time keeps two
  // of them from both seeing the export as complete.
  let queue: Promise<void> = Promise.resolve();

  const dir = (id: string) => `${DIR_PREFIX}${id}`;
  const partPath = (c: ExportChunk) => `${dir(c.exportId)}/parts/${c.name}/${c.index}`;
  const filePath = (id: string, name: string) => `${dir(id)}/Sync/${name}`;

  function logCleanupFailure(e: unknown): void {
    console.warn("crossfog: export cleanup failed", e instanceof Error ? e.name : "unknown");
  }

  async function drop(id: string): Promise<void> {
    open.delete(id);
    closed.add(id);
    await deps.fs.remove(dir(id));
  }

  async function assemble(c: ExportChunk, total: number): Promise<void> {
    const partsDir = `${dir(c.exportId)}/parts/${c.name}`;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < total; i++) parts.push(await deps.fs.read(`${partsDir}/${i}`));
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    await deps.fs.write(filePath(c.exportId, c.name), bytes);
    await deps.fs.remove(partsDir);
  }

  async function finish(id: string, state: Export): Promise<void> {
    const names = [...state.progress.keys()].sort();
    const entries = [];
    for (const name of names) {
      entries.push({ name: `Sync/${name}`, bytes: await deps.fs.read(filePath(id, name)) });
    }
    const zipPath = `${dir(id)}/Sync.zip`;
    await deps.fs.write(zipPath, writeZip(entries));
    const saved = await deps.saveAs(deps.fs.absolute(zipPath), exportName(deps.now()), ZIP_MIME);
    if (saved !== null) deps.notify(COPY.fogExportSaved(saved.name));
  }

  async function handle(c: ExportChunk): Promise<void> {
    const id = c.exportId;
    if (closed.has(id)) return;
    let state = open.get(id);
    if (state === undefined) {
      state = { files: c.files, progress: new Map() };
      open.set(id, state);
    }
    let file = state.progress.get(c.name);
    if (file === undefined) {
      file = { total: c.total, got: new Set(), complete: false };
      state.progress.set(c.name, file);
    }
    if (state.files !== c.files || file.total !== c.total || state.progress.size > state.files) {
      await drop(id);
      deps.notify(COPY.fogExportFailed);
      return;
    }
    if (file.got.has(c.index)) return;

    await deps.fs.write(partPath(c), decodeBase64(c.data));
    file.got.add(c.index);
    if (file.got.size < file.total) return;
    await assemble(c, file.total);
    file.complete = true;

    if (state.progress.size < state.files) return;
    if (![...state.progress.values()].every((f) => f.complete)) return;
    open.delete(id);
    closed.add(id);
    try {
      await finish(id, state);
    } finally {
      // A cleanup failure after a save must not read as a failed export.
      await deps.fs.remove(dir(id)).catch(logCleanupFailure);
    }
  }

  return {
    onChunk(chunk) {
      const run = queue.then(() => handle(chunk));
      queue = run.catch(() => undefined);
      return run.catch(async (e) => {
        console.warn("crossfog: export failed", e instanceof Error ? e.name : "unknown");
        await drop(chunk.exportId).catch(logCleanupFailure);
        deps.notify(COPY.fogExportFailed);
      });
    },
    clear() {
      // Queued with the chunks, so a chunk that arrives right after startup is handled after the sweep.
      const run = queue.then(() => deps.fs.removeMatching(DIR_PREFIX)).catch(logCleanupFailure);
      queue = run;
      return run;
    },
  };
}
