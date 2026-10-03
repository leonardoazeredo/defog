import { type Directory, File } from "expo-file-system";
import { FileExistsError, type FileStore } from "../fog/fileStore.js";

function baseName(uri: string): string {
  const parts = uri.split("/");
  return decodeURIComponent(parts[parts.length - 1] ?? "");
}

export function createExpoFileStore(dir: Directory): FileStore {
  if (!dir.exists) dir.create({ intermediates: true });

  function fileAt(name: string): File {
    return new File(dir, name);
  }

  return {
    async list() {
      return dir
        .list()
        .filter((item) => !item.uri.endsWith("/"))
        .map((item) => baseName(item.uri));
    },

    async exists(name) {
      return fileAt(name).exists;
    },

    async readText(name) {
      const f = fileAt(name);
      if (!f.exists) return null;
      return f.text();
    },

    async createText(name, text) {
      const f = fileAt(name);
      if (f.exists) throw new FileExistsError(name);
      const tmp = fileAt(`${name}.tmp`);
      tmp.write(text);
      await tmp.move(f);
    },

    async readBytes(name) {
      return fileAt(name).bytes();
    },

    async readRange(name, offset, length) {
      const all = await fileAt(name).bytes();
      return all.subarray(offset, offset + length);
    },

    async size(name) {
      return fileAt(name).size;
    },

    async importFrom(sourceUri, name) {
      await new File(sourceUri).copy(fileAt(name));
    },

    async rename(from, to) {
      const toFile = fileAt(to);
      if (toFile.exists) throw new FileExistsError(to);
      await fileAt(from).move(toFile);
    },

    async remove(name) {
      const f = fileAt(name);
      if (f.exists) f.delete();
    },
  };
}
