import type { WebToNative } from "../bridge/protocol.js";
import { COPY } from "../copy.js";
import type { FogStore, SourceFile } from "../fog/store.js";
import { acceptIncoming } from "../import/incoming.js";

export interface ImportFlowDeps {
  store: FogStore;
  pickFile(): Promise<SourceFile | null>;
  confirmReplace(name: string): Promise<boolean>;
  notify(text: string): void;
  releaseSource(uri: string): Promise<void>;
  setBusy(on: boolean): void;
  /** Shown to the page the next time it is ready. */
  queueNotice(text: string): void;
  /** Reloads the page; the controller owns the page's life. */
  remount(): Promise<void>;
}

export interface ImportFlow {
  /** An import is running (from the pick or the share to the page's verdict). */
  active(): boolean;
  pick(): Promise<void>;
  incoming(file: SourceFile): Promise<void>;
  /** The page's verdict on the pending copy; the caller has checked that the copy is the pending one. */
  loaded(msg: Extract<WebToNative, { type: "loaded" }>): Promise<void>;
  /** The page died: an import in progress (picking, or waiting for the verdict) is abandoned, and a share queued behind it is dropped. */
  processGone(): Promise<void>;
}

export function createImportFlow(deps: ImportFlowDeps): ImportFlow {
  const { store } = deps;

  let importActive = false;
  let pendingShare: SourceFile | null = null;

  function clearImportActive(): void {
    importActive = false;
    deps.setBusy(false);
  }

  async function endImport(): Promise<void> {
    clearImportActive();
    const queued = pendingShare;
    pendingShare = null;
    if (queued) {
      await handleIncoming(queued);
    }
  }

  async function doImport(file: SourceFile, source: "picker" | "share"): Promise<boolean> {
    deps.setBusy(true);
    try {
      await store.beginImport(file, source);
      await deps.releaseSource(file.uri);
      await deps.remount();
      return true;
    } catch {
      deps.queueNotice(COPY.importFailed);
      return false;
    }
  }

  async function handleIncoming(file: SourceFile): Promise<void> {
    if (!acceptIncoming(file.name)) {
      deps.notify(COPY.zipOnly);
      await deps.releaseSource(file.uri);
      return;
    }
    if (importActive) {
      pendingShare = file;
      return;
    }
    const current = await store.current();
    if (current) {
      const confirmed = await deps.confirmReplace(file.name);
      if (!confirmed) {
        await deps.releaseSource(file.uri);
        return;
      }
    }
    importActive = true;
    const ok = await doImport(file, "share");
    if (!ok) clearImportActive();
  }

  return {
    active: () => importActive,

    async pick() {
      if (importActive) return;
      importActive = true;
      try {
        const file = await deps.pickFile();
        if (!file) {
          clearImportActive();
          return;
        }
        if (!acceptIncoming(file.name)) {
          deps.notify(COPY.zipOnly);
          clearImportActive();
          return;
        }
        const ok = await doImport(file, "picker");
        if (!ok) clearImportActive();
      } catch {
        deps.queueNotice(COPY.importFailed);
        clearImportActive();
      }
    },

    incoming: handleIncoming,

    async loaded(msg) {
      if (msg.ok) {
        await store.promotePending();
        clearImportActive();
        const queued = pendingShare;
        pendingShare = null;
        if (queued) await handleIncoming(queued);
      } else {
        await store.discardPending();
        deps.queueNotice(COPY.notABackup);
        await endImport();
        await deps.remount();
      }
    },

    async processGone() {
      if (!importActive) return;
      const pending = await store.pending();
      if (pending) {
        await store.discardPending();
        deps.queueNotice(COPY.importFailed);
      }
      clearImportActive();
      pendingShare = null;
    },
  };
}
