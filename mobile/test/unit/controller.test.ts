import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { NativeToWeb, WebToNative } from "../../src/bridge/protocol.js";
import type { Controller } from "../../src/controller.js";
import { createController } from "../../src/controller.js";
import { COPY } from "../../src/copy.js";
import { createRestoreGuard } from "../../src/fog/restoreGuard.js";
import type { SourceFile } from "../../src/fog/store.js";
import { createFogStore } from "../../src/fog/store.js";
import type { MemoryFileStore } from "../support/memoryFileStore.js";
import { createMemoryFileStore } from "../support/memoryFileStore.js";

const A = new Uint8Array([1, 2, 3]);
const B = new Uint8Array([4, 5, 6]);
const C = new Uint8Array([7, 8, 9]);
const aSrc = "file:///cache/a.zip";
const bSrc = "file:///cache/b.zip";
const cSrc = "file:///cache/c.zip";
const sources = { [aSrc]: A, [bSrc]: B, [cSrc]: C };
const NOW = Date.parse("2026-10-01T09:00:00.000Z");

const ready: WebToNative = { v: 1, type: "ready" };
const pickBackup: WebToNative = { v: 1, type: "pickBackup" };

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let res!: (v: T) => void;
  let rej!: (e: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    res = resolve;
    rej = reject;
  });
  return { promise, resolve: res, reject: rej };
}

interface Harness {
  fs: MemoryFileStore;
  store: ReturnType<typeof createFogStore>;
  c: Controller;
  sent: NativeToWeb[];
  remounts: { count: number };
  notified: string[];
  released: string[];
  exited: { value: boolean };
  clock: { value: number };
  picks: Array<SourceFile | null>;
  pickFile: ReturnType<typeof vi.fn>;
  confirmReplace: ReturnType<typeof vi.fn>;
  confirmClear: ReturnType<typeof vi.fn>;
  shareExport: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  openAbout: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
  const fs = createMemoryFileStore({ sources });
  const clock = { value: NOW };
  const store = createFogStore(fs, {
    sha256Hex: (b) => Promise.resolve(sha(b)),
    now: () => clock.value,
  });
  const guard = createRestoreGuard(fs);
  const sent: NativeToWeb[] = [];
  const remounts = { count: 0 };
  const notified: string[] = [];
  const released: string[] = [];
  const exited = { value: false };
  const picks: Array<SourceFile | null> = [];
  const pickFile = vi.fn(() => Promise.resolve(picks.shift() ?? null));
  const confirmReplace = vi.fn(() => Promise.resolve(true));
  const confirmClear = vi.fn(() => Promise.resolve(true));
  const shareExport = vi.fn(() => Promise.resolve());
  const openExternal = vi.fn(() => Promise.resolve());
  const openAbout = vi.fn();

  const c = createController({
    store,
    guard,
    fs,
    send: (msg) => sent.push(msg),
    remount: () => {
      remounts.count++;
    },
    pickFile,
    confirmReplace,
    confirmClear,
    notify: (text) => notified.push(text),
    shareExport,
    openExternal,
    openAbout,
    exitApp: () => {
      exited.value = true;
    },
    releaseSource: (uri) => {
      released.push(uri);
      return Promise.resolve();
    },
    now: () => clock.value,
    chunkBytes: 1_048_576,
  });

  return {
    fs,
    store,
    c,
    sent,
    remounts,
    notified,
    released,
    exited,
    clock,
    picks,
    pickFile,
    confirmReplace,
    confirmClear,
    shareExport,
    openExternal,
    openAbout,
  };
}

async function saveToStore(
  store: ReturnType<typeof createFogStore>,
  uri: string,
  name: string,
): Promise<void> {
  await store.beginImport({ uri, name }, "picker");
  await store.promotePending();
}

it("first run sends none", async () => {
  const h = createHarness();
  await h.c.start();
  await h.c.onWebMessage(ready);
  expect(h.sent).toEqual([{ v: 1, type: "none" }]);
});

it("restores the saved copy", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  await h.c.start();
  await h.c.onWebMessage(ready);
  expect(h.sent).toEqual([
    {
      v: 1,
      type: "restore",
      fingerprint: sha(A),
      name: "a.zip",
      savedAt: "2026-10-01T09:00:00.000Z",
      size: 3,
      role: "current",
    },
  ]);
});

it("streams only the active copy", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  await h.c.start();
  await h.c.onWebMessage(ready);
  h.sent.length = 0;

  await h.c.onWebMessage({ v: 1, type: "needBytes", fingerprint: sha(B) });
  expect(h.sent).toHaveLength(0);

  await h.c.onWebMessage({ v: 1, type: "needBytes", fingerprint: sha(A) });
  expect(h.sent.at(-1)).toMatchObject({ type: "chunk", fingerprint: sha(A), index: 0 });
});

it("imports a picked backup and keeps it after a good load", async () => {
  const h = createHarness();
  h.picks.push({ uri: bSrc, name: "b.zip" });
  await h.c.start();
  await h.c.onWebMessage(pickBackup);
  expect(h.remounts.count).toBe(1);
  expect(h.released).toContain(bSrc);
  await h.c.onWebMessage(ready);
  expect(h.sent.at(-1)).toMatchObject({ type: "restore", role: "pending", fingerprint: sha(B) });
  await h.c.onWebMessage({ v: 1, type: "loaded", fingerprint: sha(B), ok: true, tiles: 2 });
  expect((await h.store.current())?.sha256).toBe(sha(B));
  expect(h.remounts.count).toBe(1);
});

it("a bad import keeps the saved fog and says so", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  h.picks.push({ uri: bSrc, name: "b.zip" });
  await h.c.start();
  await h.c.onWebMessage(pickBackup);
  expect(h.remounts.count).toBe(1);
  await h.c.onWebMessage(ready);
  await h.c.onWebMessage({
    v: 1,
    type: "loaded",
    fingerprint: sha(B),
    ok: false,
    reason: "noTiles",
  });
  expect((await h.store.current())?.sha256).toBe(sha(A));
  expect(h.remounts.count).toBe(2);
  h.sent.length = 0;
  await h.c.onWebMessage(ready);
  expect(h.sent.at(-2)).toMatchObject({ type: "restore", role: "current", fingerprint: sha(A) });
  expect(h.sent.at(-1)).toEqual({ v: 1, type: "notice", text: COPY.notABackup });
});

it("a bad first import says so with nothing saved", async () => {
  const h = createHarness();
  h.picks.push({ uri: bSrc, name: "b.zip" });
  await h.c.start();
  await h.c.onWebMessage(pickBackup);
  expect(h.remounts.count).toBe(1);
  await h.c.onWebMessage(ready);
  await h.c.onWebMessage({
    v: 1,
    type: "loaded",
    fingerprint: sha(B),
    ok: false,
    reason: "noTiles",
  });
  expect(h.remounts.count).toBe(2);
  h.sent.length = 0;
  await h.c.onWebMessage(ready);
  expect(h.sent[0]).toEqual({ v: 1, type: "none" });
  expect(h.sent[1]).toEqual({ v: 1, type: "notice", text: COPY.notABackup });
});

it("RF2: a second pickBackup during the pick is ignored", async () => {
  const h = createHarness();
  await h.c.start();
  const pick = deferred<SourceFile | null>();
  h.pickFile.mockReturnValueOnce(pick.promise);
  void h.c.onWebMessage(pickBackup);
  await h.c.onWebMessage(pickBackup);
  expect(h.pickFile).toHaveBeenCalledTimes(1);
  pick.resolve(null);
});

it("RF2: a share during an import waits, then asks", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  await h.c.start();
  const pick = deferred<SourceFile | null>();
  h.pickFile.mockReturnValueOnce(pick.promise);
  const pickMsg = h.c.onWebMessage(pickBackup);

  await h.c.onIncoming({ uri: cSrc, name: "c.zip" });
  expect(h.confirmReplace).not.toHaveBeenCalled();

  pick.resolve({ uri: bSrc, name: "b.zip" });
  await pickMsg;
  expect(h.remounts.count).toBe(1);

  await h.c.onWebMessage(ready);
  await h.c.onWebMessage({ v: 1, type: "loaded", fingerprint: sha(B), ok: true, tiles: 2 });

  expect(h.confirmReplace).toHaveBeenCalledWith("c.zip");
  expect(h.remounts.count).toBe(2);
  expect((await h.store.pending())?.sha256).toBe(sha(C));
});

it("asks before replacing with a shared file, and Cancel changes nothing", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  h.confirmReplace.mockResolvedValueOnce(false);
  await h.c.start();
  await h.c.onIncoming({ uri: bSrc, name: "b.zip" });
  expect(h.confirmReplace).toHaveBeenCalledWith("b.zip");
  expect(h.released).toContain(bSrc);
  expect((await h.store.current())?.sha256).toBe(sha(A));
  expect(h.remounts.count).toBe(0);
});

it("imports a shared file without asking when nothing is saved", async () => {
  const h = createHarness();
  await h.c.start();
  await h.c.onIncoming({ uri: bSrc, name: "b.zip" });
  expect(h.confirmReplace).not.toHaveBeenCalled();
  expect(h.remounts.count).toBe(1);
});

it("RF5: a non-zip share or pick gets the toast and no import", async () => {
  const h = createHarness();
  await h.c.start();
  await h.c.onIncoming({ uri: "file:///x/photo.jpg", name: "photo.jpg" });
  h.picks.push({ uri: "file:///x/notes.txt", name: "notes.txt" });
  await h.c.onWebMessage(pickBackup);
  expect(h.notified).toEqual([COPY.zipOnly, COPY.zipOnly]);
  expect(h.remounts.count).toBe(0);
  expect(h.released).toContain("file:///x/photo.jpg");
});

it("trips the guard after two crashed restores", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  await h.c.start();
  await h.c.onWebMessage(ready);
  await h.c.onProcessGone();
  await h.c.onWebMessage(ready);
  await h.c.onProcessGone();
  await h.c.onWebMessage(ready);
  expect(h.sent.at(-1)).toEqual({
    v: 1,
    type: "restoreSuspended",
    savedAt: "2026-10-01T09:00:00.000Z",
  });
});

it("Retry lifts the suspension", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  await h.c.start();
  await h.c.onWebMessage(ready);
  await h.c.onProcessGone();
  await h.c.onWebMessage(ready);
  await h.c.onProcessGone();
  await h.c.onWebMessage(ready);
  await h.c.onWebMessage({ v: 1, type: "retryRestore" });
  await h.c.onWebMessage(ready);
  expect(h.sent.at(-1)).toMatchObject({ type: "restore", role: "current" });
});

it("Clear asks first, then empties the store", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  await h.c.start();
  h.confirmClear.mockResolvedValueOnce(false);
  await h.c.onWebMessage({ v: 1, type: "clearSavedFog" });
  expect(await h.store.current()).not.toBeNull();
  expect(h.remounts.count).toBe(0);
  await h.c.onWebMessage({ v: 1, type: "clearSavedFog" });
  expect(await h.store.current()).toBeNull();
  expect(h.remounts.count).toBe(1);
});

it("an import that crashes the WebView is discarded with a notice", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  h.picks.push({ uri: bSrc, name: "b.zip" });
  await h.c.start();
  await h.c.onWebMessage(pickBackup);
  expect(h.remounts.count).toBe(1);
  await h.c.onWebMessage(ready);
  await h.c.onProcessGone();
  expect(await h.store.pending()).toBeNull();
  expect(h.remounts.count).toBe(2);
  h.sent.length = 0;
  await h.c.onWebMessage(ready);
  expect(h.sent.at(-2)).toMatchObject({ type: "restore", role: "current", fingerprint: sha(A) });
  expect(h.sent.at(-1)).toEqual({ v: 1, type: "notice", text: COPY.importFailed });
});

it("an import left over from an app crash is discarded at start", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  await h.store.beginImport({ uri: bSrc, name: "b.zip" }, "picker");
  await h.c.start();
  expect(await h.store.pending()).toBeNull();
  await h.c.onWebMessage(ready);
  expect(h.sent.at(-2)).toMatchObject({ type: "restore", role: "current", fingerprint: sha(A) });
  expect(h.sent.at(-1)).toEqual({ v: 1, type: "notice", text: COPY.importFailed });
});

it("an export failure shows a toast", async () => {
  const h = createHarness();
  await h.c.start();
  h.shareExport.mockRejectedValueOnce(new Error("share failed"));
  await h.c.onWebMessage({
    v: 1,
    type: "export",
    filename: "fog.json",
    mime: "application/json",
    text: "{}",
  });
  expect(h.notified).toContain(COPY.exportFailed);
});

it("back twice within 2 s exits", async () => {
  const h = createHarness();
  await h.c.start();
  h.c.onBackPressed();
  await h.c.onWebMessage({ v: 1, type: "back:result", handled: false });
  expect(h.notified).toContain(COPY.pressBackAgain);
  expect(h.exited.value).toBe(false);
  h.clock.value += 1500;
  h.c.onBackPressed();
  await h.c.onWebMessage({ v: 1, type: "back:result", handled: false });
  expect(h.exited.value).toBe(true);
});

it("back twice over 2 s apart shows two toasts and no exit", async () => {
  const h = createHarness();
  await h.c.start();
  h.c.onBackPressed();
  await h.c.onWebMessage({ v: 1, type: "back:result", handled: false });
  h.clock.value += 2500;
  h.c.onBackPressed();
  await h.c.onWebMessage({ v: 1, type: "back:result", handled: false });
  expect(h.notified).toHaveLength(2);
  expect(h.notified[1]).toBe(COPY.pressBackAgain);
  expect(h.exited.value).toBe(false);
});

it("forwards the back button to the page", async () => {
  const h = createHarness();
  await h.c.start();
  await h.c.onWebMessage(ready);
  h.sent.length = 0;
  h.c.onBackPressed();
  expect(h.sent.at(-1)).toEqual({ v: 1, type: "back" });
});

it("onBackPressed before ready sends nothing", async () => {
  const h = createHarness();
  await h.c.start();
  h.c.onBackPressed();
  expect(h.sent).toHaveLength(0);
});

it("openExternal delegates to the dep", async () => {
  const h = createHarness();
  await h.c.start();
  await h.c.onWebMessage({ v: 1, type: "openExternal", url: "https://fogofworld.app" });
  expect(h.openExternal).toHaveBeenCalledWith("https://fogofworld.app");
});

it("openAbout delegates to the dep", async () => {
  const h = createHarness();
  await h.c.start();
  await h.c.onWebMessage({ v: 1, type: "openAbout" });
  expect(h.openAbout).toHaveBeenCalledTimes(1);
});

it("back:result with handled=true does not exit or notify", async () => {
  const h = createHarness();
  await h.c.start();
  await h.c.onWebMessage({ v: 1, type: "back:result", handled: true });
  expect(h.exited.value).toBe(false);
  expect(h.notified).toHaveLength(0);
});

it("a successful restore resets the crash guard so a later crash does not suspend", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  await h.c.start();
  await h.c.onWebMessage(ready);
  await h.c.onProcessGone();
  await h.c.onWebMessage(ready);
  await h.c.onWebMessage({ v: 1, type: "loaded", fingerprint: sha(A), ok: true, tiles: 5 });
  await h.c.onProcessGone();
  h.sent.length = 0;
  await h.c.onWebMessage(ready);
  expect(h.sent.at(-1)).toMatchObject({ type: "restore", role: "current" });
});

it("loaded with wrong fingerprint and no pending is a no-op", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  await h.c.start();
  await h.c.onWebMessage(ready);
  const remountsBefore = h.remounts.count;
  await h.c.onWebMessage({ v: 1, type: "loaded", fingerprint: sha(B), ok: true, tiles: 1 });
  expect(h.remounts.count).toBe(remountsBefore);
  expect((await h.store.current())?.sha256).toBe(sha(A));
});

it("loaded with non-matching pending fingerprint is a no-op", async () => {
  const h = createHarness();
  await h.store.beginImport({ uri: bSrc, name: "b.zip" }, "picker");
  await h.c.start();
  await h.c.onWebMessage(ready);
  const remountsBefore = h.remounts.count;
  await h.c.onWebMessage({ v: 1, type: "loaded", fingerprint: sha(C), ok: true, tiles: 1 });
  expect(h.remounts.count).toBe(remountsBefore);
});

it("RF2: queued share is processed after a bad import", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  await h.c.start();
  const pick = deferred<SourceFile | null>();
  h.pickFile.mockReturnValueOnce(pick.promise);
  const pickMsg = h.c.onWebMessage(pickBackup);

  await h.c.onIncoming({ uri: cSrc, name: "c.zip" });
  expect(h.confirmReplace).not.toHaveBeenCalled();

  pick.resolve({ uri: bSrc, name: "b.zip" });
  await pickMsg;
  await h.c.onWebMessage(ready);
  await h.c.onWebMessage({
    v: 1,
    type: "loaded",
    fingerprint: sha(B),
    ok: false,
    reason: "noTiles",
  });

  expect(h.confirmReplace).toHaveBeenCalledWith("c.zip");
  expect(h.remounts.count).toBeGreaterThanOrEqual(2);
});

it("clearSavedFog during an active import is ignored", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  await h.c.start();
  const pick = deferred<SourceFile | null>();
  h.pickFile.mockReturnValueOnce(pick.promise);
  void h.c.onWebMessage(pickBackup);
  await h.c.onWebMessage({ v: 1, type: "clearSavedFog" });
  expect(h.confirmClear).not.toHaveBeenCalled();
  pick.resolve(null);
});

it("needBytes streams using the pending meta when fingerprint matches pending", async () => {
  const h = createHarness();
  await saveToStore(h.store, aSrc, "a.zip");
  h.picks.push({ uri: bSrc, name: "b.zip" });
  await h.c.start();
  await h.c.onWebMessage(pickBackup);
  await h.c.onWebMessage(ready);
  h.sent.length = 0;
  await h.c.onWebMessage({ v: 1, type: "needBytes", fingerprint: sha(B) });
  expect(h.sent.at(-1)).toMatchObject({ type: "chunk", fingerprint: sha(B) });
});

it("pickFile returning null cancels import without notifying", async () => {
  const h = createHarness();
  await h.c.start();
  h.picks.push(null);
  await h.c.onWebMessage(pickBackup);
  expect(h.notified).toHaveLength(0);
  expect(h.remounts.count).toBe(0);
  await h.c.onWebMessage(pickBackup);
  expect(h.pickFile).toHaveBeenCalledTimes(2);
});
