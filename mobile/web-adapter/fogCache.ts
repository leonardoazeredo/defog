export interface FogCache {
  get(fingerprint: string): Promise<Uint8Array | null>;
  /** Clears the store and writes `bytes` under `fingerprint` as the sole entry. */
  putOnly(fingerprint: string, bytes: Uint8Array): Promise<void>;
  clearAll(): Promise<void>;
}

const DB_NAME = "crossfog";
const STORE = "copies";

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const noop: FogCache = {
  get: () => Promise.resolve(null),
  putOnly: () => Promise.resolve(),
  clearAll: () => Promise.resolve(),
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
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).get(fingerprint);
          req.onsuccess = () => {
            const raw = req.result as Uint8Array | undefined;
            if (raw == null) {
              resolve(null);
              return;
            }
            // Normalize to a detached, plain Uint8Array: fake-indexeddb returns Node.js Buffer
            // values, which fail strict equality checks (e.g. toEqual in tests) because Buffer
            // and Uint8Array have different constructors despite Buffer being a subclass.
            // A plain copy also avoids returning a view over an engine-internal backing store.
            const copy = new Uint8Array(raw.length);
            copy.set(raw);
            resolve(copy);
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    },

    putOnly(fingerprint, bytes) {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          const clearReq = store.clear();
          clearReq.onsuccess = () => {
            store.put(bytes, fingerprint);
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    clearAll() {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },
  };
}
