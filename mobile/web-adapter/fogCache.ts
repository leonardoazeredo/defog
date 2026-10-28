export interface FogCache {
  get(fingerprint: string): Promise<Uint8Array | null>;
  /** Clears the store and writes `bytes` under `fingerprint` as the sole entry. */
  putOnly(fingerprint: string, bytes: Uint8Array): Promise<void>;
  clearAll(): Promise<void>;
  /** The cells an activity's track revealed, with the rules and the activity fingerprint it was made under. */
  getReveal(activityId: string): Promise<CachedReveal | null>;
  putReveal(activityId: string, stamp: RevealStamp, cells: Int32Array): Promise<void>;
  deleteReveal(activityId: string): Promise<void>;
  revealIds(): Promise<string[]>;
}

/** What a cached reveal was made from; any difference from the current values means recompute. */
export interface RevealStamp {
  rulesVersion: number;
  /** Hash of the whole rules object, so a tuned number without a version bump is still noticed. */
  rulesHash: string;
  /** The activity's `endedAt` and distance: a track replaced under the same id usually differs in one of them (a cheap proxy, not a hash of the points). */
  endedAt: string;
  distanceM: number;
}

interface CachedReveal extends RevealStamp {
  /** `[cx, cy]` pairs as Int32 values. */
  cells: ArrayBuffer;
}

const DB_NAME = "crossfog";
const STORE = "copies";
const REVEALS = "reveals";

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 3);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // Reveals without a fingerprint cannot be checked; they are rebuilt from the tracks.
      if (event.oldVersion > 0 && event.oldVersion < 3 && db.objectStoreNames.contains(REVEALS)) {
        db.deleteObjectStore(REVEALS);
      }
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      if (!db.objectStoreNames.contains(REVEALS)) {
        db.createObjectStore(REVEALS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Another connection to the old version stays open: the upgrade would wait for it, and `ready` with it,
    // so the page runs without the cache instead.
    req.onblocked = () => reject(new Error("blocked"));
  });
}

// Every call resolves to `fallback` on a throw, an error or an abort (a full disk aborts at commit and
// fires onabort, not onerror), so a broken store never stalls the history sync that awaits it.
function run<T>(
  fallback: T,
  body: (done: (value: T) => void, fail: () => void) => void,
): Promise<T> {
  return new Promise((resolve) => {
    try {
      body(resolve, () => resolve(fallback));
    } catch {
      resolve(fallback);
    }
  });
}

const noop: FogCache = {
  get: () => Promise.resolve(null),
  putOnly: () => Promise.resolve(),
  clearAll: () => Promise.resolve(),
  getReveal: () => Promise.resolve(null),
  putReveal: () => Promise.resolve(),
  deleteReveal: () => Promise.resolve(),
  revealIds: () => Promise.resolve([]),
};

export async function openFogCache(
  idb: IDBFactory | undefined,
  enabled: boolean,
): Promise<FogCache> {
  if (!enabled || idb == null) return noop;

  let db: IDBDatabase;
  try {
    db = await openDb(idb);
  } catch {
    return noop;
  }

  return {
    get(fingerprint) {
      return run<Uint8Array | null>(null, (done, fail) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(fingerprint);
        req.onsuccess = () => {
          const raw = req.result as Uint8Array | undefined;
          if (raw == null) {
            done(null);
            return;
          }
          // Normalize to a detached, plain Uint8Array: fake-indexeddb returns Node.js Buffer
          // values, which fail strict equality checks (e.g. toEqual in tests) because Buffer
          // and Uint8Array have different constructors despite Buffer being a subclass.
          // A plain copy also avoids returning a view over an engine-internal backing store.
          const copy = new Uint8Array(raw.length);
          copy.set(raw);
          done(copy);
        };
        req.onerror = fail;
      });
    },

    putOnly(fingerprint, bytes) {
      return run<void>(undefined, (done, fail) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const clearReq = store.clear();
        clearReq.onsuccess = () => {
          store.put(bytes, fingerprint);
        };
        tx.oncomplete = () => done();
        tx.onerror = fail;
        tx.onabort = fail;
      });
    },

    clearAll() {
      return run<void>(undefined, (done, fail) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => done();
        tx.onerror = fail;
        tx.onabort = fail;
      });
    },

    getReveal(activityId) {
      return run<CachedReveal | null>(null, (done, fail) => {
        const req = db.transaction(REVEALS, "readonly").objectStore(REVEALS).get(activityId);
        req.onsuccess = () => {
          const raw = req.result as Partial<CachedReveal> | undefined;
          const { rulesVersion, rulesHash, endedAt, distanceM, cells } = raw ?? {};
          const whole =
            typeof rulesVersion === "number" &&
            typeof rulesHash === "string" &&
            typeof endedAt === "string" &&
            typeof distanceM === "number" &&
            Object.prototype.toString.call(cells) === "[object ArrayBuffer]";
          done(
            whole
              ? { rulesVersion, rulesHash, endedAt, distanceM, cells: cells as ArrayBuffer }
              : null,
          );
        };
        req.onerror = fail;
      });
    },

    putReveal(activityId, stamp, cells) {
      return run<void>(undefined, (done, fail) => {
        const tx = db.transaction(REVEALS, "readwrite");
        // slice() copies just this view's bytes; `cells.buffer` could be a larger buffer shared with
        // other data, and the caller may reuse the array.
        tx.objectStore(REVEALS).put({ ...stamp, cells: cells.slice().buffer }, activityId);
        tx.oncomplete = () => done();
        tx.onerror = fail;
        tx.onabort = fail;
      });
    },

    deleteReveal(activityId) {
      return run<void>(undefined, (done, fail) => {
        const tx = db.transaction(REVEALS, "readwrite");
        tx.objectStore(REVEALS).delete(activityId);
        tx.oncomplete = () => done();
        tx.onerror = fail;
        tx.onabort = fail;
      });
    },

    revealIds() {
      return run<string[]>([], (done, fail) => {
        const req = db.transaction(REVEALS, "readonly").objectStore(REVEALS).getAllKeys();
        req.onsuccess = () => done((req.result as IDBValidKey[]).map(String));
        req.onerror = fail;
      });
    },
  };
}
