import { Directory, File, Paths } from "expo-file-system";
import { EXPORT_DIR_PREFIX, type ExportFs } from "../flows/exportFlow.js";

// The protocol's id and name patterns already keep these paths inside the cache; this is the second lock,
// so a path built wrongly elsewhere cannot reach the cache root or above it.
const segments = (path: string) => {
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Error("unsafe cache path");
  }
  return parts;
};
const baseName = (uri: string) => {
  const last = uri.replace(/\/$/, "").split("/").pop() ?? "";
  // A stray % in an entry name must not stop the sweep.
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/** The export flow's files, inside the cache directory. */
export function createExportFs(): ExportFs {
  const fileAt = (path: string) => new File(Paths.cache, ...segments(path));
  return {
    async write(path, bytes) {
      const parts = segments(path);
      const parent = new Directory(Paths.cache, ...parts.slice(0, -1));
      if (!parent.exists) parent.create({ intermediates: true });
      await fileAt(path).write(bytes);
    },
    async read(path) {
      return fileAt(path).bytes();
    },
    async remove(path) {
      const dir = new Directory(Paths.cache, ...segments(path));
      if (dir.exists) {
        dir.delete();
        return;
      }
      const file = fileAt(path);
      if (file.exists) file.delete();
    },
    async removeExportDirs() {
      let failed = 0;
      for (const item of new Directory(Paths.cache).list()) {
        if (!baseName(item.uri).startsWith(EXPORT_DIR_PREFIX)) continue;
        // One entry that will not go must not leave the rest, which hold plaintext tiles.
        try {
          item.delete();
        } catch {
          failed++;
        }
      }
      if (failed > 0) throw new Error(`${failed} cache entries not removed`);
    },
    absolute: (path) => decodeURIComponent(fileAt(path).uri.replace(/^file:\/\//, "")),
  };
}
