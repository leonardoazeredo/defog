import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { openFogCache, type RevealStamp } from "../../web-adapter/fogCache.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const ACT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
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

const stamp = (rulesVersion: number, changes: Partial<RevealStamp> = {}): RevealStamp => ({
  rulesVersion,
  rulesHash: "abc",
  endedAt: "2026-01-01T11:00:00Z",
  distanceM: 1000,
  ...changes,
});

describe("reveals", () => {
  const cells = new Int32Array([1, 2, 3, 4, 5, 6]);

  it("round-trips a reveal with its rules version", async () => {
    const c = await openFogCache(idb, true);
    expect(await c.getReveal(ACT)).toBeNull();
    await c.putReveal(ACT, stamp(3), cells);
    const got = await c.getReveal(ACT);
    expect(got).toMatchObject(stamp(3));
    expect(Array.from(new Int32Array(got?.cells ?? new ArrayBuffer(0)))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("treats a record without the fingerprint fields as missing", async () => {
    const c = await openFogCache(idb, true);
    await new Promise<void>((resolve, reject) => {
      const req = idb.open("crossfog");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("reveals", "readwrite");
        tx.objectStore("reveals").put({ rulesVersion: 1, cells: new ArrayBuffer(8) }, ACT);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    expect(await c.getReveal(ACT)).toBeNull();
  });

  it("drops the reveals of the earlier database version and keeps the import copy", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = idb.open("crossfog", 2);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("copies");
        req.result.createObjectStore("reveals");
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(["copies", "reveals"], "readwrite");
        tx.objectStore("copies").put(a, A);
        tx.objectStore("reveals").put({ rulesVersion: 1, cells: new ArrayBuffer(8) }, ACT);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    const c = await openFogCache(idb, true);
    expect(await c.revealIds()).toEqual([]);
    expect(await c.get(A)).toEqual(a);
  });

  it("stores a copy, so a later change to the array does not reach the cache", async () => {
    const c = await openFogCache(idb, true);
    const mine = new Int32Array([7, 8]);
    await c.putReveal(ACT, stamp(1), mine);
    mine[0] = 99;
    const got = await c.getReveal(ACT);
    expect(Array.from(new Int32Array(got?.cells ?? new ArrayBuffer(0)))).toEqual([7, 8]);
  });

  it("stores only the cells of a view, not the buffer behind it", async () => {
    const c = await openFogCache(idb, true);
    const backing = new Int32Array([1, 2, 3, 4, 5, 6]);
    await c.putReveal(ACT, stamp(1), backing.subarray(2, 4));
    const got = await c.getReveal(ACT);
    expect(Array.from(new Int32Array(got?.cells ?? new ArrayBuffer(0)))).toEqual([3, 4]);
  });

  it("overwrites an earlier reveal of the same activity", async () => {
    const c = await openFogCache(idb, true);
    await c.putReveal(ACT, stamp(1), cells);
    await c.putReveal(ACT, stamp(2), new Int32Array([9, 9]));
    const got = await c.getReveal(ACT);
    expect(got?.rulesVersion).toBe(2);
    expect(new Int32Array(got?.cells ?? new ArrayBuffer(0)).length).toBe(2);
  });

  it("deleteReveal removes one reveal and revealIds lists the rest", async () => {
    const c = await openFogCache(idb, true);
    await c.putReveal(ACT, stamp(1), cells);
    await c.putReveal(OTHER, stamp(1), cells);
    expect((await c.revealIds()).sort()).toEqual([ACT, OTHER].sort());
    await c.deleteReveal(ACT);
    expect(await c.getReveal(ACT)).toBeNull();
    expect(await c.revealIds()).toEqual([OTHER]);
  });

  it("deleting an unknown reveal is harmless", async () => {
    const c = await openFogCache(idb, true);
    await expect(c.deleteReveal(ACT)).resolves.toBeUndefined();
  });

  it("survives being reopened", async () => {
    await (await openFogCache(idb, true)).putReveal(ACT, stamp(4), cells);
    const got = await (await openFogCache(idb, true)).getReveal(ACT);
    expect(got?.rulesVersion).toBe(4);
  });

  it("is untouched by clearAll, which belongs to the import copy", async () => {
    const c = await openFogCache(idb, true);
    await c.putOnly(A, a);
    await c.putReveal(ACT, stamp(1), cells);
    await c.clearAll();
    expect(await c.get(A)).toBeNull();
    expect(await c.revealIds()).toEqual([ACT]);
  });

  it("is untouched by putOnly, which replaces the import copy", async () => {
    const c = await openFogCache(idb, true);
    await c.putReveal(ACT, stamp(1), cells);
    await c.putOnly(A, a);
    expect(await c.revealIds()).toEqual([ACT]);
  });

  it("treats a stored record of the wrong shape as missing", async () => {
    const c = await openFogCache(idb, true);
    await new Promise<void>((resolve, reject) => {
      const req = idb.open("crossfog");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("reveals", "readwrite");
        tx.objectStore("reveals").put({ rulesVersion: 1 }, ACT);
        tx.objectStore("reveals").put({ rulesVersion: "1", cells: new ArrayBuffer(8) }, OTHER);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    expect(await c.getReveal(ACT)).toBeNull();
    expect(await c.getReveal(OTHER)).toBeNull();
  });

  it("does nothing when disabled", async () => {
    const c = await openFogCache(idb, false);
    await c.putReveal(ACT, stamp(1), cells);
    expect(await c.getReveal(ACT)).toBeNull();
    expect(await c.revealIds()).toEqual([]);
  });

  it("never rejects when IndexedDB is broken", async () => {
    const broken = {
      open: () => {
        throw new Error("SecurityError");
      },
    } as unknown as IDBFactory;
    const c = await openFogCache(broken, true);
    await expect(c.putReveal(ACT, stamp(1), cells)).resolves.toBeUndefined();
    expect(await c.getReveal(ACT)).toBeNull();
    expect(await c.revealIds()).toEqual([]);
  });
});

describe("upgrading a version 1 database", () => {
  function seedVersion1(factory: IDBFactory): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = factory.open("crossfog", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("copies");
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("copies", "readwrite");
        tx.objectStore("copies").put(a, A);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  it("keeps the saved copy and adds the reveals store", async () => {
    await seedVersion1(idb);
    const c = await openFogCache(idb, true);
    expect(await c.get(A)).toEqual(a);
    await c.putReveal(ACT, stamp(1), new Int32Array([1, 2]));
    expect(await c.revealIds()).toEqual([ACT]);
  });
});

describe("an open connection that blocks the upgrade", () => {
  it("gives the no-op cache instead of waiting for it", async () => {
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open("crossfog", 2);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("copies");
        req.result.createObjectStore("reveals");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const c = await openFogCache(idb, true);
    await c.putOnly(A, a);
    expect(await c.get(A)).toBeNull();
    holder.close();
  });
});
