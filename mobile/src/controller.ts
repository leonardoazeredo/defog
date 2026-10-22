import type { NativeToWeb, WebToNative } from "./bridge/protocol.js";
import { COPY } from "./copy.js";
import { createImportFlow } from "./flows/importFlow.js";
import type { Flows } from "./flows/types.js";
import type { FileStore } from "./fog/fileStore.js";
import type { ReloadGuard } from "./fog/reloadGuard.js";
import type { FogStore, SourceFile } from "./fog/store.js";
import { zipName } from "./fog/store.js";
import { streamCopy } from "./fog/transfer.js";

export interface ControllerDeps {
  store: FogStore;
  guard: ReloadGuard;
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
  setBusy(on: boolean): void;
  now(): number;
  chunkBytes: number;
  flows: Flows;
  /** Wired only when `__DEV__` is true; the controller ignores `devAddActivity` without it. */
  devAddActivity?: () => Promise<void>;
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

  const importFlow = createImportFlow({
    store,
    pickFile: deps.pickFile,
    confirmReplace: deps.confirmReplace,
    notify: deps.notify,
    releaseSource: deps.releaseSource,
    setBusy: deps.setBusy,
    queueNotice,
    remount: doRemount,
  });

  async function handleReady(): Promise<void> {
    const pending = await store.pending();
    if (pending) {
      activeFingerprint = pending.sha256;
      deps.send({
        v: 1,
        type: "reload",
        fingerprint: pending.sha256,
        name: pending.name,
        savedAt: pending.savedAt,
        size: pending.size,
        role: "pending",
      });
    } else {
      const current = await store.current();
      if (current) {
        const result = await guard.beforeReload(current.sha256);
        if (result === "suspended") {
          activeFingerprint = null;
          deps.send({ v: 1, type: "reloadSuspended", savedAt: current.savedAt });
        } else {
          activeFingerprint = current.sha256;
          deps.send({
            v: 1,
            type: "reload",
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
    await deps.flows.ready();
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
    await importFlow.loaded(msg);
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
          await importFlow.pick();
          break;
        case "clearSavedFog":
          if (importFlow.active()) return;
          if (await deps.confirmClear()) {
            await store.clear();
            await guard.reset();
            await doRemount();
          }
          break;
        case "retryReload":
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
        case "sendRoute":
          await deps.flows.sendRoute(msg.route);
          break;
        case "needTrack":
          await deps.flows.needTrack(msg.activityId);
          break;
        case "deleteActivity":
          await deps.flows.deleteActivity(msg.activityId);
          break;
        case "exportBinary": {
          const { v: _v, type: _type, ...exportChunk } = msg;
          await deps.flows.exportBinary(exportChunk);
          break;
        }
        case "backup":
          await deps.flows.backup();
          break;
        case "restore":
          if (importFlow.active()) {
            deps.notify(COPY.restoreBusy);
            return;
          }
          if (await deps.flows.restore()) {
            await guard.reset();
            await doRemount();
          }
          break;
        case "settings":
          await deps.flows.settings(msg.json);
          break;
        case "settingsApplied":
          await deps.flows.settingsApplied();
          break;
        case "devAddActivity":
          if (__DEV__) await deps.devAddActivity?.();
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
      await importFlow.incoming(file);
    },

    async onProcessGone() {
      await started;
      await importFlow.processGone();
      await doRemount();
    },

    onBackPressed() {
      sendMsg({ v: 1, type: "back" });
    },
  };
}
