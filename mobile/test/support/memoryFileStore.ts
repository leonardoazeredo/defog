import type { FileStore } from "../../src/fog/fileStore.js";
import { FileExistsError } from "../../src/fog/fileStore.js";

export class SimulatedCrash extends Error {}

export interface MemoryFileStore extends FileStore {
  files: Map<string, Uint8Array>;
  mutations: number;
}

export function createMemoryFileStore(opts?: {
  files?: Map<string, Uint8Array>;
  sources?: Record<string, Uint8Array>;
  crashAtMutation?: number;
}): MemoryFileStore {
  const files: Map<string, Uint8Array> = opts?.files ?? new Map();
  const sources: Record<string, Uint8Array> = opts?.sources ?? {};
  const crashAt = opts?.crashAtMutation;
  let mutations = 0;

  function tick(fn: () => void): void {
    const next = mutations + 1;
    if (crashAt != null && next === crashAt) {
      throw new SimulatedCrash(`crash at mutation ${next}`);
    }
    fn();
    mutations = next;
  }

  const store: MemoryFileStore = {
    get files() {
      return files;
    },
    get mutations() {
      return mutations;
    },

    async list() {
      return [...files.keys()];
    },

    async exists(name) {
      return files.has(name);
    },

    async readText(name) {
      const data = files.get(name);
      if (data == null) return null;
      return new TextDecoder().decode(data);
    },

    async createText(name, text) {
      if (files.has(name)) throw new FileExistsError(`${name} already exists`);
      const tmpName = `${name}.tmp`;
      const encoded = new TextEncoder().encode(text);
      tick(() => files.set(tmpName, encoded));
      tick(() => {
        files.delete(tmpName);
        files.set(name, encoded);
      });
    },

    async readBytes(name) {
      const data = files.get(name);
      if (data == null) throw new Error(`not found: ${name}`);
      return data;
    },

    async readRange(name, offset, length) {
      const data = files.get(name);
      if (data == null) throw new Error(`not found: ${name}`);
      return data.slice(offset, offset + length);
    },

    async size(name) {
      const data = files.get(name);
      if (data == null) throw new Error(`not found: ${name}`);
      return data.length;
    },

    async importFrom(sourceUri, name) {
      const source = sources[sourceUri];
      if (source == null) throw new Error(`source not found: ${sourceUri}`);
      tick(() => files.set(name, source));
    },

    async rename(from, to) {
      if (files.has(to)) throw new FileExistsError(`${to} already exists`);
      const data = files.get(from);
      if (data == null) throw new Error(`not found: ${from}`);
      tick(() => {
        files.delete(from);
        files.set(to, data);
      });
    },

    async remove(name) {
      if (!files.has(name)) return;
      tick(() => files.delete(name));
    },
  };

  return store;
}
