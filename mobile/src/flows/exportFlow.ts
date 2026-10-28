import { decodeBase64 } from "../bridge/base64.js";
import type { ExportChunk, ExportState } from "../bridge/protocol.js";
import { COPY } from "../copy.js";
import { localDate } from "../localDate.js";
import { writeZip, type ZipEntry } from "../platform/zipWriter.js";
import { warnClass } from "./warn.js";

/** Files under the cache directory, by path relative to it; parents are created on write. */
export interface ExportFs {
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  /** Removes a file or a directory with everything in it; a path that is not there is fine. */
  remove(path: string): Promise<void>;
  /** Removes every `export-*` entry of the cache. Tries every one, then rejects with the first failure. */
  removeExportDirs(): Promise<void>;
  /** A file system path (no scheme) for a path inside the cache. */
  absolute(path: string): string;
}

export interface ExportFlowDeps {
  fs: ExportFs;
  /** Asks where to save, then streams the file there; null when the user backs out of the picker. */
  saveAs(path: string, name: string, mime: string): Promise<{ name: string } | null>;
  notify(text: string): void;
  /** Tells the page how its export went, so its button and status line follow it. */
  status(exportId: string, state: ExportState): void;
  /** Runs `fn` after `ms`; the returned function cancels it. Defaults to `setTimeout`. */
  setTimer?(fn: () => void, ms: number): () => void;
  now(): number;
}

export interface ExportFlow {
  /** Never rejects: a failure is reported to the user and drops that export. */
  onChunk(chunk: ExportChunk): Promise<void>;
  /**
   * A chunk of this export failed the bridge's schema: drop the export (open or not yet started), tell the page
   * it failed and notify. A no-op for an export among the last MAX_CLOSED finished or failed. Never rejects.
   */
  abandon(exportId: string): Promise<void>;
  /** Called once at startup: removes the directories of exports that never finished. Never rejects. */
  clear(): Promise<void>;
}

export const EXPORT_DIR_PREFIX = "export-";
const ZIP_MIME = "application/zip";
// The page sends every chunk of an export at once, so a minute without one means it is not coming
// (a reload, a WebView that died, a throw mid-send); its plaintext parts should not wait for the next start.
const EXPORT_IDLE_MS = 60_000;
// How many finished or failed ids are kept so a late chunk does not start its export again. The oldest is forgotten
// first; the page mints a fresh id for every export, so only a chunk that many exports late could restart one.
const MAX_CLOSED = 256;

interface FileProgress {
  total: number;
  got: Set<number>;
}

interface InFlightExport {
  files: number;
  progress: Map<string, FileProgress>;
  cancelExpiry: () => void;
}

// What the flow was doing when it failed, so a log tells a picker failure from a short disk.
type Stage = "receiving" | "assembling" | "zipping" | "saving";

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

// Local time on purpose: the name is for the person who saves it, and their day is the local one.
function exportName(now: number): string {
  return `fog-of-world-export-${localDate(now)}.zip`;
}

export function createExportFlow(deps: ExportFlowDeps): ExportFlow {
  const setTimer = deps.setTimer ?? defaultTimer;
  const open = new Map<string, InFlightExport>();
  // A chunk that arrives after its export finished or failed must not start a second one.
  const closed = new Set<string>();
  // Chunks are separate WebView messages that can interleave; handling them one at a time keeps two
  // of them from both seeing the export as complete.
  let queue: Promise<void> = Promise.resolve();
  // The queue runs one job at a time, so one variable holds the stage of the job running.
  let stage: Stage = "receiving";

  const dir = (id: string) => `${EXPORT_DIR_PREFIX}${id}`;
  const partPath = (c: ExportChunk) => `${dir(c.exportId)}/parts/${c.name}/${c.index}`;
  const filePath = (id: string, name: string) => `${dir(id)}/Sync/${name}`;

  function enqueue(job: () => Promise<void>): Promise<void> {
    const run = queue.then(job);
    queue = run.catch(() => undefined);
    return run;
  }

  function logCleanupFailure(e: unknown): void {
    warnClass("export", "cleanup failed", e);
  }

  // The page and the toast only hear of the outcome; a throw from either must not change it.
  function tell(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      warnClass("export", "could not report the outcome", e);
    }
  }

  function close(id: string): void {
    open.get(id)?.cancelExpiry();
    open.delete(id);
    closed.add(id);
    if (closed.size > MAX_CLOSED) closed.delete(closed.values().next().value as string);
  }

  async function fail(id: string): Promise<void> {
    close(id);
    tell(() => deps.status(id, "failed"));
    tell(() => deps.notify(COPY.fogExportFailed));
    await deps.fs.remove(dir(id)).catch(logCleanupFailure);
  }

  // Armed after each handled chunk. The expiry runs as a queued job, so a chunk already queued ahead of it
  // re-arms the timer and cancels it; a chunk queued after it finds the export already failed.
  function armExpiry(id: string, state: InFlightExport): void {
    state.cancelExpiry();
    let live = true;
    const cancel = setTimer(() => {
      void enqueue(async () => {
        if (!live || open.get(id) !== state) return;
        // A fixed line, so a report can tell a timeout from a failed write.
        console.warn("crossfog: export idle, dropped");
        await fail(id);
      });
    }, EXPORT_IDLE_MS);
    state.cancelExpiry = () => {
      live = false;
      cancel();
    };
  }

  async function assemble(id: string, name: string, total: number): Promise<void> {
    const partsDir = `${dir(id)}/parts/${name}`;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < total; i++) parts.push(await deps.fs.read(`${partsDir}/${i}`));
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    await deps.fs.write(filePath(id, name), bytes);
    await deps.fs.remove(partsDir);
  }

  async function finish(id: string, state: InFlightExport): Promise<void> {
    stage = "zipping";
    const names = [...state.progress.keys()].sort();
    const entries: ZipEntry[] = [];
    for (const name of names) {
      entries.push({ name: `Sync/${name}`, bytes: await deps.fs.read(filePath(id, name)) });
    }
    const zipPath = `${dir(id)}/Sync.zip`;
    await deps.fs.write(zipPath, writeZip(entries));
    stage = "saving";
    tell(() => deps.status(id, "saving"));
    const saved = await deps.saveAs(deps.fs.absolute(zipPath), exportName(deps.now()), ZIP_MIME);
    tell(() => deps.status(id, saved === null ? "cancelled" : "saved"));
    if (saved !== null) tell(() => deps.notify(COPY.fogExportSaved(saved.name)));
  }

  async function handle(c: ExportChunk): Promise<void> {
    const id = c.exportId;
    if (closed.has(id)) return;
    let state = open.get(id);
    if (state === undefined) {
      state = { files: c.files, progress: new Map(), cancelExpiry: () => {} };
      open.set(id, state);
    }
    let file = state.progress.get(c.name);
    if (file === undefined) {
      file = { total: c.total, got: new Set() };
      state.progress.set(c.name, file);
    }
    if (state.files !== c.files || file.total !== c.total || state.progress.size > state.files) {
      await fail(id);
      return;
    }
    if (!file.got.has(c.index)) {
      await deps.fs.write(partPath(c), decodeBase64(c.data));
      file.got.add(c.index);
      if (file.got.size === file.total) {
        stage = "assembling";
        await assemble(id, c.name, file.total);
      }
    }

    const complete = (f: FileProgress) => f.got.size === f.total;
    if (state.progress.size < state.files || ![...state.progress.values()].every(complete)) {
      armExpiry(id, state);
      return;
    }
    const finished = state;
    close(id);
    try {
      await finish(id, finished);
    } finally {
      // A cleanup failure after a save must not read as a failed export.
      await deps.fs.remove(dir(id)).catch(logCleanupFailure);
    }
  }

  return {
    onChunk(chunk) {
      return enqueue(async () => {
        stage = "receiving";
        try {
          await handle(chunk);
        } catch (e) {
          warnClass("export", `failed while ${stage}`, e);
          await fail(chunk.exportId);
        }
      });
    },
    abandon(exportId) {
      return enqueue(async () => {
        if (!closed.has(exportId)) await fail(exportId);
      }).catch(logCleanupFailure);
    },
    clear() {
      // Queued with the chunks, so a chunk that arrives right after startup is handled after the sweep.
      return enqueue(() => deps.fs.removeExportDirs()).catch(logCleanupFailure);
    },
  };
}
