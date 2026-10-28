import type { WebToNative } from "../bridge/protocol.js";
import { COPY } from "../copy.js";
import type { FogStore, SourceFile } from "../fog/store.js";
import { acceptIncoming } from "../import/incoming.js";
import { warnClass } from "./warn.js";

/** `notify`, `queueNotice` and `setBusy` must not throw: the import's own failure handling calls them. */
export interface ImportFlowDeps {
  store: FogStore;
  pickFile(): Promise<SourceFile | null>;
  confirmReplace(name: string): Promise<boolean>;
  notify(text: string): void;
  releaseSource(uri: string): Promise<void>;
  setBusy(on: boolean): void;
  /** Shown to the page the next time it is ready, so the flow queues only when a `ready` will follow. */
  queueNotice(text: string): void;
  /** Reloads the page; the controller owns the page's life. */
  remount(): Promise<void>;
}

/**
 * Never rejects on a store, picker or remount failure: it ends any import it started and tells the user, so
 * busy is never left on; a share that fails before it takes the import leaves a running one alone.
 */
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

  // The cached source is a copy of the user's location history; a failed release leaves only that copy behind,
  // so it is logged and the outcome the user was told stands.
  async function release(uri: string): Promise<void> {
    try {
      await deps.releaseSource(uri);
    } catch (e) {
      warnClass("import", "could not release a source file", e);
    }
  }

  // A failure is a toast (`notify`): a queued notice would wait for some later `ready` and show a stale failure then.
  async function doImport(file: SourceFile, source: "picker" | "share"): Promise<boolean> {
    deps.setBusy(true);
    try {
      await store.beginImport(file, source);
    } catch (e) {
      warnClass("import", "could not begin an import", e);
      await release(file.uri);
      deps.notify(COPY.importFailed);
      return false;
    }
    await release(file.uri);
    try {
      await deps.remount();
      return true;
    } catch (e) {
      warnClass("import", "could not show an import", e);
      // The native remount is a state bump that does not throw today; should one fail, the copy goes, or the
      // next `ready` would load the import the user was just told had failed.
      try {
        await store.discardPending();
      } catch (e2) {
        warnClass("import", "could not drop an import it could not show", e2);
      }
      deps.notify(COPY.importFailed);
      return false;
    }
  }

  async function handleIncoming(file: SourceFile): Promise<void> {
    try {
      await incoming(file);
    } catch (e) {
      warnClass("import", "could not take a shared file", e);
      // Nothing is cleared: a throw comes before this share takes the import (`doImport` catches its own),
      // so any import active now belongs to a pick or an earlier share.
      await release(file.uri);
      deps.notify(COPY.importFailed);
    }
  }

  async function incoming(file: SourceFile): Promise<void> {
    if (!acceptIncoming(file.name)) {
      deps.notify(COPY.zipOnly);
      await release(file.uri);
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
        await release(file.uri);
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
      } catch (e) {
        warnClass("import", "could not pick a file", e);
        deps.notify(COPY.importFailed);
        clearImportActive();
      }
    },

    incoming: handleIncoming,

    async loaded(msg) {
      try {
        if (msg.ok) await store.promotePending();
        else await store.discardPending();
      } catch (e) {
        // No remount: after a failed discard the page would be handed the same bad copy again, and after a
        // failed promote the page already shows the import it could not keep.
        warnClass("import", msg.ok ? "could not keep an import" : "could not drop a bad import", e);
        deps.notify(COPY.importFailed);
        await endImport();
        return;
      }
      await endImport();
      if (msg.ok) return;
      try {
        await deps.remount();
        deps.queueNotice(COPY.notABackup);
      } catch (e) {
        warnClass("import", "could not reload after a bad import", e);
        deps.notify(COPY.notABackup);
      }
    },

    async processGone() {
      if (!importActive) return;
      try {
        const pending = await store.pending();
        if (pending) {
          await store.discardPending();
          deps.queueNotice(COPY.importFailed);
        }
      } catch (e) {
        warnClass("import", "could not drop an interrupted import", e);
        deps.queueNotice(COPY.importFailed);
      }
      clearImportActive();
      pendingShare = null;
    },
  };
}
