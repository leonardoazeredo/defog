import type { ExportFs } from "../../src/flows/exportFlow.js";

export interface MemoryExportFs extends ExportFs {
  files: Map<string, Uint8Array>;
}

export function createMemoryExportFs(): MemoryExportFs {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async write(path, bytes) {
      files.set(path, bytes);
    },
    async read(path) {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`not found: ${path}`);
      return bytes;
    },
    async remove(path) {
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      }
    },
    async removeExportDirs() {
      for (const key of [...files.keys()]) if (key.startsWith("export-")) files.delete(key);
    },
    absolute: (path) => `/cache/${path}`,
  };
}
