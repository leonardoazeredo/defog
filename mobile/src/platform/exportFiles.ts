import { Directory, File, Paths } from "expo-file-system";
import type { ExportFs } from "../flows/exportFlow.js";

const segments = (path: string) => path.split("/");
const baseName = (uri: string) => decodeURIComponent(uri.replace(/\/$/, "").split("/").pop() ?? "");

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
    async removeMatching(prefix) {
      for (const item of new Directory(Paths.cache).list()) {
        if (baseName(item.uri).startsWith(prefix)) item.delete();
      }
    },
    absolute: (path) => decodeURIComponent(fileAt(path).uri.replace(/^file:\/\//, "")),
  };
}
