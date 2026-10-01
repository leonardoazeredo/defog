import type { NativeToWeb, WebToNative } from "./bridge/protocol.js";
import { COPY } from "./copy.js";
import type { FileStore } from "./fog/fileStore.js";
import type { RestoreGuard } from "./fog/restoreGuard.js";
import type { FogStore, SourceFile } from "./fog/store.js";
import { zipName } from "./fog/store.js";
import { streamCopy } from "./fog/transfer.js";
import { acceptIncoming } from "./import/incoming.js";

export interface ControllerDeps {
  store: FogStore;
  guard: RestoreGuard;
  fs: FileStore;
  send(msg: NativeToWeb): void;
  remount(): void;
  pickFile(): Promise<SourceFile | null>;
  confirmReplace(name: string): Promise<boolean>;
  confirmClear(): Promise<boolean>;
  notify(text: string): void;
  shareExport(file: { filename: string; mime: string; text: string }): Promise<void>;
  openExternal(url: string): Promise<void>;
  openAbout(): void;
  exitApp(): void;
  releaseSource(uri: string): Promise<void>;
  now(): number;
  chunkBytes: number;
}

export interface Controller {
  start(): Promise<void>;
  onWebMessage(msg: WebToNative): Promise<void>;
  onIncoming(file: SourceFile): Promise<void>;
  onProcessGone(): Promise<void>;
  onBackPressed(): void;
}

export function createController(deps: ControllerDeps): Controller {
  const { store, guard, fs } = deps;

  let started: Promise<void> | null = null;
  let startResolve!: () => void;
  let pageReady = false;
  const noticeQueue: string[] = [];

  let importActive = false;
  let pendingShare: SourceFile | null = null;
  let activeFingerprint: string | null = null;
  let activeAbort: AbortController | null = null;

  let lastBackAt: number | null = null;

  function sendMsg(msg: NativeToWeb): void {
    if (pageReady) deps.send(msg);
  }

  function queueNotice(text: string): void {
    noticeQueue.push(text);
  }

  function flushNotices(): void {
    for (const text of noticeQueue.splice(0)) {
      deps.send({ v: 1, type: "notice", text });
    }
  }

  async function doRemount(): Promise<void> {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    pageReady = false;
    deps.remount();
  }

  async function handleReady(): Promise<void> {
    const pending = await store.pending();
    if (pending) {
      activeFingerprint = pending.sha256;
      deps.send({
        v: 1,
        type: "restore",
        fingerprint: pending.sha256,
        name: pending.name,
        savedAt: pending.savedAt,
        size: pending.size,
        role: "pending",
      });
    } else {
      const current = await store.current();
      if (current) {
        const result = await guard.beforeRestore(current.sha256);
        if (result === "suspended") {
          activeFingerprint = null;
          deps.send({ v: 1, type: "restoreSuspended", savedAt: current.savedAt });
        } else {
          activeFingerprint = current.sha256;
          deps.send({
            v: 1,
            type: "restore",
            fingerprint: current.sha256,
            name: current.name,
            savedAt: current.savedAt,
            size: current.size,
            role: "current",
          });
        }
      } else {
        activeFingerprint = null;
        deps.send({ v: 1, type: "none" });
      }
    }
    flushNotices();
  }

  async function handleNeedBytes(fingerprint: string): Promise<void> {
    if (fingerprint !== activeFingerprint) return;
    const current = await store.current();
    const pending = await store.pending();
    const meta =
      pending?.sha256 === fingerprint ? pending : current?.sha256 === fingerprint ? current : null;
    if (!meta) return;
    const abort = new AbortController();
    activeAbort = abort;
    await streamCopy({
      fs,
      zipName: zipName(meta),
      fingerprint,
      send: deps.send,
      chunkBytes: deps.chunkBytes,
      signal: abort.signal,
    });
  }

  async function endImport(): Promise<void> {
    importActive = false;
    const queued = pendingShare;
    pendingShare = null;
    if (queued) {
      await handleIncoming(queued);
    }
  }

  async function handleLoaded(msg: Extract<WebToNative, { type: "loaded" }>): Promise<void> {
    const pending = await store.pending();
    if (!pending || pending.sha256 !== msg.fingerprint) {
      if (pending === null) {
        const current = await store.current();
        if (current?.sha256 === msg.fingerprint) {
          await guard.onLoaded();
        }
      }
      return;
    }

    if (msg.ok) {
      await store.promotePending();
      importActive = false;
      const queued = pendingShare;
      pendingShare = null;
      if (queued) await handleIncoming(queued);
    } else {
      await store.discardPending();
      queueNotice(COPY.notABackup);
      await endImport();
      await doRemount();
    }
  }

  async function doImport(file: SourceFile, source: "picker" | "share"): Promise<boolean> {
    try {
      await store.beginImport(file, source);
      await deps.releaseSource(file.uri);
      await doRemount();
      return true;
    } catch {
      queueNotice(COPY.importFailed);
      return false;
    }
  }

  async function handlePickBackup(): Promise<void> {
    if (importActive) return;
    importActive = true;
    try {
      const file = await deps.pickFile();
      if (!file) {
        importActive = false;
        return;
      }
      if (!acceptIncoming(file.name)) {
        deps.notify(COPY.zipOnly);
        importActive = false;
        return;
      }
      const ok = await doImport(file, "picker");
      if (!ok) importActive = false;
    } catch {
      queueNotice(COPY.importFailed);
      importActive = false;
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
    if (!ok) importActive = false;
  }

  return {
    async start() {
      if (!started) {
        started = new Promise<void>((resolve) => {
          startResolve = resolve;
        });
        const result = await store.recover();
        if (result.discardedPending) queueNotice(COPY.importFailed);
        startResolve();
      }
      return started;
    },

    async onWebMessage(msg: WebToNative) {
      await started;
      switch (msg.type) {
        case "ready":
          pageReady = true;
          await handleReady();
          break;
        case "needBytes":
          await handleNeedBytes(msg.fingerprint);
          break;
        case "loaded":
          await handleLoaded(msg);
          break;
        case "pickBackup":
          await handlePickBackup();
          break;
        case "clearSavedFog":
          if (importActive) return;
          if (await deps.confirmClear()) {
            await store.clear();
            await guard.reset();
            await doRemount();
          }
          break;
        case "retryRestore":
          await guard.reset();
          await doRemount();
          break;
        case "export":
          try {
            await deps.shareExport({ filename: msg.filename, mime: msg.mime, text: msg.text });
          } catch {
            deps.notify(COPY.exportFailed);
          }
          break;
        case "openExternal":
          await deps.openExternal(msg.url);
          break;
        case "openAbout":
          deps.openAbout();
          break;
        case "back:result":
          if (!msg.handled) {
            const now = deps.now();
            if (lastBackAt !== null && now - lastBackAt < 2000) {
              lastBackAt = null;
              deps.exitApp();
            } else {
              lastBackAt = now;
              deps.notify(COPY.pressBackAgain);
            }
          }
          break;
      }
    },

    async onIncoming(file: SourceFile) {
      await started;
      await handleIncoming(file);
    },

    async onProcessGone() {
      await started;
      if (importActive) {
        const pending = await store.pending();
        if (pending) {
          await store.discardPending();
          queueNotice(COPY.importFailed);
        }
        importActive = false;
        pendingShare = null;
      }
      await doRemount();
    },

    onBackPressed() {
      sendMsg({ v: 1, type: "back" });
    },
  };
}
