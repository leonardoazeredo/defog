import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it } from "vitest";
import { openFogCache } from "../../web-adapter/fogCache.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const a = new Uint8Array([1, 2, 3]);
const b = new Uint8Array([4, 5, 6]);

let idb: IDBFactory;
beforeEach(() => {
  idb = new IDBFactory();
});

it("misses, then hits after putOnly", async () => {
  const c = await openFogCache(idb, true);
  expect(await c.get(A)).toBeNull();
  await c.putOnly(A, a);
  expect(await c.get(A)).toEqual(a);
});

it("keeps only the latest copy", async () => {
  const c = await openFogCache(idb, true);
  await c.putOnly(A, a);
  await c.putOnly(B, b);
  expect(await c.get(A)).toBeNull();
  expect(await c.get(B)).toEqual(b);
});

it("survives being reopened", async () => {
  await (await openFogCache(idb, true)).putOnly(A, a);
  expect(await (await openFogCache(idb, true)).get(A)).toEqual(a);
});

it("clearAll empties it", async () => {
  const c = await openFogCache(idb, true);
  await c.putOnly(A, a);
  await c.clearAll();
  expect(await c.get(A)).toBeNull();
});

it("does nothing when disabled", async () => {
  const c = await openFogCache(idb, false);
  await c.putOnly(A, a);
  expect(await c.get(A)).toBeNull();
});

it("never rejects when IndexedDB is broken", async () => {
  const broken = {
    open: () => {
      throw new Error("SecurityError");
    },
  } as unknown as IDBFactory;
  const c = await openFogCache(broken, true);
  await expect(c.putOnly(A, a)).resolves.toBeUndefined();
  expect(await c.get(A)).toBeNull();
});

it("does nothing when idb is undefined", async () => {
  const c = await openFogCache(undefined, true);
  await c.putOnly(A, a);
  expect(await c.get(A)).toBeNull();
});
