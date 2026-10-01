import { beforeEach, expect, it } from "vitest";
import type { RestoreGuard } from "../../../src/fog/restoreGuard.js";
import { createRestoreGuard } from "../../../src/fog/restoreGuard.js";
import type { MemoryFileStore } from "../../support/memoryFileStore.js";
import { createMemoryFileStore } from "../../support/memoryFileStore.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

let files: Map<string, Uint8Array>;
let fs: MemoryFileStore;
let guard: RestoreGuard;

beforeEach(() => {
  files = new Map();
  fs = createMemoryFileStore({ files });
  guard = createRestoreGuard(fs);
});

it("allows two attempts per fingerprint, then suspends", async () => {
  expect(await guard.beforeRestore(A)).toBe("restore");
  expect(await guard.beforeRestore(A)).toBe("restore");
  expect(await guard.beforeRestore(A)).toBe("suspended");
});

it("stays suspended after the app restarts", async () => {
  await guard.beforeRestore(A);
  await guard.beforeRestore(A);
  await guard.beforeRestore(A);
  const guard2 = createRestoreGuard(createMemoryFileStore({ files: new Map(fs.files) }));
  expect(await guard2.beforeRestore(A)).toBe("suspended");
});

it("a load clears the count", async () => {
  await guard.beforeRestore(A);
  await guard.onLoaded();
  expect(await guard.beforeRestore(A)).toBe("restore");
  expect(await guard.beforeRestore(A)).toBe("restore");
});

it("another fingerprint starts again", async () => {
  await guard.beforeRestore(A);
  await guard.beforeRestore(A);
  expect(await guard.beforeRestore(B)).toBe("restore");
});

it("reset lifts a suspension", async () => {
  await guard.beforeRestore(A);
  await guard.beforeRestore(A);
  await guard.beforeRestore(A);
  await guard.reset();
  expect(await guard.beforeRestore(A)).toBe("restore");
});

it("treats a corrupt record as none", async () => {
  fs.files.set("restoring.json", new TextEncoder().encode("{"));
  expect(await guard.beforeRestore(A)).toBe("restore");
});

it("treats a null JSON record as none", async () => {
  fs.files.set("restoring.json", new TextEncoder().encode("null"));
  expect(await guard.beforeRestore(A)).toBe("restore");
});

it("treats a non-object JSON record as none", async () => {
  fs.files.set("restoring.json", new TextEncoder().encode("42"));
  expect(await guard.beforeRestore(A)).toBe("restore");
});

it("treats a record missing the attempts field as none", async () => {
  fs.files.set("restoring.json", new TextEncoder().encode(JSON.stringify({ fingerprint: A })));
  expect(await guard.beforeRestore(A)).toBe("restore");
});

it("treats a record with a non-string fingerprint as none", async () => {
  fs.files.set(
    "restoring.json",
    new TextEncoder().encode(JSON.stringify({ fingerprint: 123, attempts: 1 })),
  );
  expect(await guard.beforeRestore(A)).toBe("restore");
});

it("treats a record with a non-number attempts as none", async () => {
  fs.files.set(
    "restoring.json",
    new TextEncoder().encode(JSON.stringify({ fingerprint: A, attempts: "1" })),
  );
  expect(await guard.beforeRestore(A)).toBe("restore");
});
