import { afterEach, describe, expect, it, vi } from "vitest";
import { COPY } from "../../../src/copy.js";
import { createImportFlow } from "../../../src/flows/importFlow.js";
import type { CopyMeta, FogStore, SourceFile } from "../../../src/fog/store.js";

const META: CopyMeta = {
  name: "Sync.zip",
  sha256: "a".repeat(64),
  size: 3,
  savedAt: "2026-10-01T09:00:00.000Z",
  source: "picker",
};

// The error message carries a path; `onlyNamesLogged` checks that only the error class reaches the log.
const fail = () => Promise.reject(new Error("disk at /data/user/0 is full"));

function setup(store: Partial<FogStore>, remount: () => Promise<void> = async () => undefined) {
  const full: FogStore = {
    recover: async () => ({ discardedPending: false }),
    current: async () => null,
    pending: async () => META,
    beginImport: async () => META,
    promotePending: async () => undefined,
    discardPending: async () => undefined,
    clear: async () => undefined,
    ...store,
  };
  const busy: boolean[] = [];
  const notified: string[] = [];
  const queued: string[] = [];
  const flow = createImportFlow({
    store: full,
    pickFile: async () => ({ uri: "file:///cache/a.zip", name: "a.zip" }),
    confirmReplace: async () => true,
    notify: (t) => notified.push(t),
    releaseSource: async () => undefined,
    setBusy: (on) => busy.push(on),
    queueNotice: (t) => queued.push(t),
    remount,
  });
  return { flow, busy, notified, queued };
}

const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
afterEach(() => warn.mockClear());

function onlyNamesLogged(): void {
  for (const args of warn.mock.calls) {
    expect(args).toHaveLength(2);
    expect(args[1]).toBe("Error");
  }
}

describe("import flow failures", () => {
  it("ends the import and says so when the good copy cannot be promoted", async () => {
    const { flow, busy, notified } = setup({ promotePending: fail });
    await flow.pick();
    expect(flow.active()).toBe(true);

    await expect(
      flow.loaded({ v: 1, type: "loaded", fingerprint: META.sha256, ok: true, tiles: 1 }),
    ).resolves.toBeUndefined();

    expect(flow.active()).toBe(false);
    expect(busy.at(-1)).toBe(false);
    expect(notified).toEqual([COPY.importFailed]);
    onlyNamesLogged();
  });

  it("ends the import when the bad copy cannot be discarded", async () => {
    const { flow, busy } = setup({ discardPending: fail });
    await flow.pick();

    await expect(
      flow.loaded({ v: 1, type: "loaded", fingerprint: META.sha256, ok: false, reason: "unzip" }),
    ).resolves.toBeUndefined();

    expect(flow.active()).toBe(false);
    expect(busy.at(-1)).toBe(false);
    onlyNamesLogged();
  });

  it("ends the import and does not reject when the page cannot be reloaded after a bad copy", async () => {
    let remounts = 0;
    // The first remount shows the pending copy; only the one after the bad verdict fails.
    const { flow, busy, queued } = setup({}, () => (remounts++ === 0 ? Promise.resolve() : fail()));
    await flow.pick();

    await expect(
      flow.loaded({ v: 1, type: "loaded", fingerprint: META.sha256, ok: false, reason: "unzip" }),
    ).resolves.toBeUndefined();

    expect(flow.active()).toBe(false);
    expect(busy.at(-1)).toBe(false);
    expect(queued).toEqual([COPY.notABackup]);
    onlyNamesLogged();
  });

  it("keeps a running import when a refused share cannot be released", async () => {
    let choose: (f: SourceFile | null) => void = () => undefined;
    const busy: boolean[] = [];
    const flow = createImportFlow({
      store: {
        recover: async () => ({ discardedPending: false }),
        current: async () => null,
        pending: async () => META,
        beginImport: async () => META,
        promotePending: async () => undefined,
        discardPending: async () => undefined,
        clear: async () => undefined,
      },
      pickFile: () => new Promise((r) => (choose = r)),
      confirmReplace: async () => true,
      notify: () => undefined,
      releaseSource: fail,
      setBusy: (on) => busy.push(on),
      queueNotice: () => undefined,
      remount: async () => undefined,
    });
    const picking = flow.pick();

    await expect(
      flow.incoming({ uri: "file:///cache/b.7z", name: "b.7z" }),
    ).resolves.toBeUndefined();

    expect(flow.active()).toBe(true);
    expect(busy).toEqual([]);
    choose(null);
    await picking;
  });

  it("keeps a pick that started while a share waited on its replace question", async () => {
    let choose: (f: SourceFile | null) => void = () => undefined;
    let refuse: (e: Error) => void = () => undefined;
    const flow = createImportFlow({
      store: {
        recover: async () => ({ discardedPending: false }),
        current: async () => META,
        pending: async () => META,
        beginImport: async () => META,
        promotePending: async () => undefined,
        discardPending: async () => undefined,
        clear: async () => undefined,
      },
      pickFile: () => new Promise((r) => (choose = r)),
      confirmReplace: () =>
        new Promise<boolean>((_, j) => {
          refuse = j;
        }),
      notify: () => undefined,
      releaseSource: async () => undefined,
      setBusy: () => undefined,
      queueNotice: () => undefined,
      remount: async () => undefined,
    });
    const sharing = flow.incoming({ uri: "file:///cache/b.zip", name: "b.zip" });
    await new Promise((r) => setTimeout(r, 0));
    const picking = flow.pick();
    refuse(new Error("dialog gone"));
    await sharing;

    expect(flow.active()).toBe(true);
    choose(null);
    await picking;
  });

  it("says a shared file could not be imported when the saved fog cannot be read", async () => {
    const { flow, notified } = setup({ current: fail });

    await expect(
      flow.incoming({ uri: "file:///cache/b.zip", name: "b.zip" }),
    ).resolves.toBeUndefined();

    expect(flow.active()).toBe(false);
    expect(notified).toEqual([COPY.importFailed]);
    onlyNamesLogged();
  });

  it("ends the import when the page dies and the pending copy cannot be read", async () => {
    const { flow, busy, queued } = setup({ pending: fail });
    await flow.pick();

    await expect(flow.processGone()).resolves.toBeUndefined();

    expect(flow.active()).toBe(false);
    expect(busy.at(-1)).toBe(false);
    expect(queued).toEqual([COPY.importFailed]);
    onlyNamesLogged();
  });

  it("logs the error class of an import that could not begin", async () => {
    const { flow, queued } = setup({ beginImport: fail });
    await flow.pick();

    expect(flow.active()).toBe(false);
    expect(queued).toEqual([COPY.importFailed]);
    expect(warn).toHaveBeenCalledTimes(1);
    onlyNamesLogged();
  });
});
