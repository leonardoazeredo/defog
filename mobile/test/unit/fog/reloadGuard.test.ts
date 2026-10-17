import { beforeEach, expect, it } from "vitest";
import type { ReloadGuard } from "../../../src/fog/reloadGuard.js";
import { createReloadGuard } from "../../../src/fog/reloadGuard.js";
import type { MemoryFileStore } from "../../support/memoryFileStore.js";
import { createMemoryFileStore } from "../../support/memoryFileStore.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

let files: Map<string, Uint8Array>;
let fs: MemoryFileStore;
let guard: ReloadGuard;

beforeEach(() => {
  files = new Map();
  fs = createMemoryFileStore({ files });
  guard = createReloadGuard(fs);
});

it("allows two attempts per fingerprint, then suspends", async () => {
  expect(await guard.beforeReload(A)).toBe("reload");
  expect(await guard.beforeReload(A)).toBe("reload");
  expect(await guard.beforeReload(A)).toBe("suspended");
});

it("stays suspended after the app restarts", async () => {
  await guard.beforeReload(A);
  await guard.beforeReload(A);
  await guard.beforeReload(A);
  const guard2 = createReloadGuard(createMemoryFileStore({ files: new Map(fs.files) }));
  expect(await guard2.beforeReload(A)).toBe("suspended");
});

it("a load clears the count", async () => {
  await guard.beforeReload(A);
  await guard.onLoaded();
  expect(await guard.beforeReload(A)).toBe("reload");
  expect(await guard.beforeReload(A)).toBe("reload");
});

it("another fingerprint starts again", async () => {
  await guard.beforeReload(A);
  await guard.beforeReload(A);
  expect(await guard.beforeReload(B)).toBe("reload");
});

it("reset lifts a suspension", async () => {
  await guard.beforeReload(A);
  await guard.beforeReload(A);
  await guard.beforeReload(A);
  await guard.reset();
  expect(await guard.beforeReload(A)).toBe("reload");
});

it("treats a corrupt record as none", async () => {
  fs.files.set("restoring.json", new TextEncoder().encode("{"));
  expect(await guard.beforeReload(A)).toBe("reload");
});

it("treats a null JSON record as none", async () => {
  fs.files.set("restoring.json", new TextEncoder().encode("null"));
  expect(await guard.beforeReload(A)).toBe("reload");
});

it("treats a non-object JSON record as none", async () => {
  fs.files.set("restoring.json", new TextEncoder().encode("42"));
  expect(await guard.beforeReload(A)).toBe("reload");
});

it("treats a record missing the attempts field as none", async () => {
  fs.files.set("restoring.json", new TextEncoder().encode(JSON.stringify({ fingerprint: A })));
  expect(await guard.beforeReload(A)).toBe("reload");
});

it("treats a record with a non-string fingerprint as none", async () => {
  fs.files.set(
    "restoring.json",
    new TextEncoder().encode(JSON.stringify({ fingerprint: 123, attempts: 1 })),
  );
  expect(await guard.beforeReload(A)).toBe("reload");
});

it("treats a record with a non-number attempts as none", async () => {
  fs.files.set(
    "restoring.json",
    new TextEncoder().encode(JSON.stringify({ fingerprint: A, attempts: "1" })),
  );
  expect(await guard.beforeReload(A)).toBe("reload");
});

it("reads the marker an older build left, so an update keeps counting attempts", async () => {
  const enc = new TextEncoder();
  const seeded = new Map([
    ["restoring.json", enc.encode(JSON.stringify({ fingerprint: A, attempts: 2 }))],
  ]);
  const fromOldBuild = createReloadGuard(createMemoryFileStore({ files: seeded }));
  expect(await fromOldBuild.beforeReload(A)).toBe("suspended");
});
