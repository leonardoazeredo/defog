import { createHash } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { FogStore, SourceFile } from "../../../src/fog/store.js";
import { createFogStore, zipName } from "../../../src/fog/store.js";
import type { MemoryFileStore } from "../../support/memoryFileStore.js";
import { createMemoryFileStore, SimulatedCrash } from "../../support/memoryFileStore.js";

const A = new Uint8Array([1, 2, 3]);
const B = new Uint8Array([4, 5, 6]);
const sources = { "file:///inbox/a.zip": A, "file:///inbox/b.zip": B };
const deps = { sha256Hex: nodeSha256Hex, now: () => Date.parse("2026-10-01T09:00:00.000Z") };
const fileA: SourceFile = { uri: "file:///inbox/a.zip", name: "a.zip" };
const fileB: SourceFile = { uri: "file:///inbox/b.zip", name: "b.zip" };

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function nodeSha256Hex(bytes: Uint8Array): Promise<string> {
  return Promise.resolve(sha(bytes));
}

let fs: MemoryFileStore;
let store: FogStore;

beforeEach(() => {
  fs = createMemoryFileStore({ sources });
  store = createFogStore(fs, deps);
});

async function save(s: FogStore, file: SourceFile) {
  await s.beginImport(file, "picker");
  await s.promotePending();
}

async function mutationsFor(
  fn: (s: FogStore) => Promise<void>,
  opts?: { savedFirst?: SourceFile },
): Promise<number> {
  const setupFs = createMemoryFileStore({ sources });
  const setupStore = createFogStore(setupFs, deps);
  if (opts?.savedFirst) await save(setupStore, opts.savedFirst);
  const trackFs = createMemoryFileStore({ files: new Map(setupFs.files), sources });
  const trackStore = createFogStore(trackFs, deps);
  const before = trackFs.mutations;
  await fn(trackStore);
  return trackFs.mutations - before;
}

async function storeWithSaved(
  file: SourceFile,
  opts?: { crashAfterSetup?: number },
): Promise<{ store: FogStore; fs: MemoryFileStore }> {
  const setupFs = createMemoryFileStore({ sources });
  const setupStore = createFogStore(setupFs, deps);
  await save(setupStore, file);
  const crashFs = createMemoryFileStore({
    files: new Map(setupFs.files),
    sources,
    crashAtMutation: opts?.crashAfterSetup,
  });
  return { store: createFogStore(crashFs, deps), fs: crashFs };
}

it("starts empty", async () => {
  expect(await store.current()).toBeNull();
  expect(await store.pending()).toBeNull();
  expect(await store.recover()).toEqual({ discardedPending: false });
});

it("beginImport copies the file and records it as pending", async () => {
  const meta = await store.beginImport(fileA, "picker");
  expect(meta).toEqual({
    name: "a.zip",
    sha256: sha(A),
    size: 3,
    savedAt: "2026-10-01T09:00:00.000Z",
    source: "picker",
  });
  expect(await store.pending()).toEqual(meta);
  expect(await store.current()).toBeNull();
  expect(fs.files.get(`${sha(A)}.zip`)).toEqual(A);
});

it("promotes pending to current", async () => {
  await save(store, fileA);
  expect(await store.current()).toMatchObject({ sha256: sha(A) });
  expect(await store.pending()).toBeNull();
  expect([...fs.files.keys()].sort()).toEqual([`${sha(A)}.zip`, "current-000001.json"]);
});

it("a new import replaces the saved copy and drops the old zip", async () => {
  await save(store, fileA);
  await save(store, fileB);
  expect([...fs.files.keys()].sort()).toEqual([`${sha(B)}.zip`, "current-000002.json"]);
});

it("discarding an import never touches the saved copy", async () => {
  await save(store, fileA);
  await store.beginImport(fileB, "picker");
  await store.discardPending();
  expect(await store.current()).toMatchObject({ sha256: sha(A) });
  expect(fs.files.has(`${sha(B)}.zip`)).toBe(false);
});

it("RF1: re-importing the saved backup keeps its zip", async () => {
  await save(store, fileA);
  await save(store, fileA);
  expect(fs.files.get(`${sha(A)}.zip`)).toEqual(A);
  await store.beginImport(fileA, "share");
  await store.discardPending();
  expect(await store.current()).toMatchObject({ sha256: sha(A) });
  expect(fs.files.get(`${sha(A)}.zip`)).toEqual(A);
});

it("clear removes every fog file", async () => {
  await save(store, fileA);
  await store.clear();
  expect([...fs.files.keys()].filter((k) => !k.startsWith("_"))).toEqual([]);
});

it("recover removes leftovers and keeps the saved copy", async () => {
  await save(store, fileA);
  for (const n of [
    "incoming.tmp",
    "current-000009.json.tmp",
    `${"d".repeat(64)}.zip`,
    "pending.json",
  ])
    fs.files.set(n, new Uint8Array([0]));
  expect(await store.recover()).toEqual({ discardedPending: true });
  expect([...fs.files.keys()].sort()).toEqual([`${sha(A)}.zip`, "current-000001.json"]);
});

it("RF3: a crash at any step of an import leaves the old copy or the new one", async () => {
  const total = await mutationsFor((s) => save(s, fileB), { savedFirst: fileA });
  for (let k = 1; k <= total; k++) {
    const crashed = await storeWithSaved(fileA, { crashAfterSetup: k });
    await expect(save(crashed.store, fileB)).rejects.toBeInstanceOf(SimulatedCrash);
    const fs2 = createMemoryFileStore({ files: new Map(crashed.fs.files), sources });
    const next = createFogStore(fs2, deps);
    await next.recover();
    const cur = await next.current();
    expect(cur).not.toBeNull();
    if (!cur) return;
    const expected = cur.sha256 === sha(A) ? A : B;
    expect(fs2.files.get(zipName(cur))).toEqual(expected);
    expect([...fs2.files.keys()].filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect([...fs2.files.keys()].filter((n) => n.startsWith("current-"))).toHaveLength(1);
  }
});

it("RF3: a crash during clear leaves the old copy or nothing, never a broken pointer", async () => {
  const total = await mutationsFor((s) => s.clear(), { savedFirst: fileA });
  for (let k = 1; k <= total; k++) {
    const crashed = await storeWithSaved(fileA, { crashAfterSetup: k });
    await expect(crashed.store.clear()).rejects.toBeInstanceOf(SimulatedCrash);
    const fs2 = createMemoryFileStore({ files: new Map(crashed.fs.files), sources });
    const next = createFogStore(fs2, deps);
    await next.recover();
    const cur = await next.current();
    if (cur !== null) {
      expect(cur.sha256).toBe(sha(A));
      expect(fs2.files.get(zipName(cur))).toEqual(A);
    }
    expect([...fs2.files.keys()].filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect([...fs2.files.keys()].filter((n) => n.startsWith("current-"))).toHaveLength(
      cur === null ? 0 : 1,
    );
  }
});

it("does not treat a filename with wrong prefix as a pointer", async () => {
  const meta = {
    name: "a.zip",
    sha256: sha(A),
    size: 3,
    savedAt: "2026-10-01T09:00:00.000Z",
    source: "picker",
  };
  fs.files.set("xcurrent-000001.json", new TextEncoder().encode(JSON.stringify(meta)));
  fs.files.set(`${sha(A)}.zip`, A);
  expect(await store.current()).toBeNull();
});

it("does not treat a filename with wrong suffix as a pointer", async () => {
  await save(store, fileA);
  const metaB = {
    name: "b.zip",
    sha256: sha(B),
    size: 3,
    savedAt: "2026-10-01T09:00:00.000Z",
    source: "picker",
  };
  fs.files.set("current-000002.json.bak", new TextEncoder().encode(JSON.stringify(metaB)));
  expect((await store.current())?.sha256).toBe(sha(A));
});

it("records the source field as provided", async () => {
  const meta = await store.beginImport(fileA, "share");
  expect(meta.source).toBe("share");
  expect((await store.pending())?.source).toBe("share");
});

it("current() returns null when the pointer file is missing from storage", async () => {
  await save(store, fileA);
  fs.files.delete("current-000001.json");
  expect(await store.current()).toBeNull();
});

it("recover keeps the highest-numbered valid pointer and removes the rest", async () => {
  const enc = new TextEncoder();
  const metaA = {
    name: "a.zip",
    sha256: sha(A),
    size: 3,
    savedAt: "2026-10-01T09:00:00.000Z",
    source: "picker",
  };
  const metaB = {
    name: "b.zip",
    sha256: sha(B),
    size: 3,
    savedAt: "2026-10-01T09:00:00.000Z",
    source: "picker",
  };
  fs.files.set(`${sha(A)}.zip`, A);
  fs.files.set(`${sha(B)}.zip`, B);
  fs.files.set("current-000001.json", enc.encode(JSON.stringify(metaA)));
  fs.files.set("current-000002.json", enc.encode(JSON.stringify(metaB)));
  await store.recover();
  expect((await store.current())?.sha256).toBe(sha(B));
  expect(fs.files.has("current-000001.json")).toBe(false);
  expect(fs.files.has("current-000002.json")).toBe(true);
});

it("RF1: dedup path removes incoming.tmp instead of renaming it", async () => {
  await save(store, fileA);
  await store.beginImport(fileA, "picker");
  expect(fs.files.has("incoming.tmp")).toBe(false);
});

it("a second beginImport overwrites the pending record", async () => {
  await store.beginImport(fileA, "picker");
  await store.beginImport(fileB, "picker");
  expect((await store.pending())?.sha256).toBe(sha(B));
});

it("promotePending throws when there is no pending import", async () => {
  await expect(store.promotePending()).rejects.toThrow("no pending import");
});

it("clear removes a pending import", async () => {
  await store.beginImport(fileA, "picker");
  await store.clear();
  expect(await store.pending()).toBeNull();
});

it("clear only removes pointer files, not other files in storage", async () => {
  await save(store, fileA);
  fs.files.set("app.db", new Uint8Array([1]));
  await store.clear();
  expect(fs.files.has("app.db")).toBe(true);
  expect(fs.files.has("current-000001.json")).toBe(false);
});
