import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import { type DatabaseFiles, LIVE_DB } from "../backup/replace.js";
import type { Scratch } from "../backup/types.js";
import type { SourceFile } from "../fog/store.js";
import { copyToUri, createDocument, displayNameOf } from "./watchLinkModule.js";

const FILE_SCHEME = /^file:\/\//;
const toPath = (uri: string) => decodeURIComponent(uri.replace(FILE_SCHEME, ""));
const toUri = (path: string) => `file://${path}`;

/** The SQLite directory expo-sqlite opens databases from. */
const sqliteDir = () => new Directory(Paths.document, "SQLite");

export function createDatabaseFiles(): DatabaseFiles {
  const fileAt = (name: string) => new File(sqliteDir(), name);
  return {
    pathOf: (name) => toPath(fileAt(name).uri),
    exists: (name) => fileAt(name).exists,
    remove(name) {
      const f = fileAt(name);
      if (f.exists) f.delete();
    },
    move(from, to) {
      fileAt(from).moveSync(fileAt(to));
    },
  };
}

const scratchDir = () => new Directory(Paths.cache, "backup");

export function createScratch(): Scratch & { clear(): void } {
  const dir = scratchDir();
  if (!dir.exists) dir.create({ intermediates: true });
  return {
    path: (name) => toPath(new File(dir, name).uri),
    uri: toUri,
    async writeBytes(path, bytes) {
      await new File(toUri(path)).write(bytes);
    },
    async remove(path) {
      const f = new File(toUri(path));
      if (f.exists) f.delete();
    },
    async freeBytes() {
      return Paths.availableDiskSpace;
    },
    async databaseBytes() {
      const live = new File(sqliteDir(), LIVE_DB);
      const wal = new File(sqliteDir(), `${LIVE_DB}-wal`);
      return live.size + wal.size;
    },
    // A crash mid-backup leaves a copy of the history in the cache; the next start removes it.
    clear() {
      if (dir.exists) dir.delete();
      dir.create({ intermediates: true });
    },
  };
}

/** Asks where to save, then streams the file there; null when the user backs out of the picker. */
export async function saveFileAs(
  path: string,
  name: string,
  mime: string,
): Promise<{ name: string } | null> {
  const uri = await createDocument(name, mime);
  if (uri === null) return null;
  await copyToUri(path, uri);
  return { name: (await displayNameOf(uri)) ?? name };
}

/** Picks a backup file without copying it: the native side streams it into the cache. */
export async function pickRestoreFile(): Promise<SourceFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    copyToCacheDirectory: false,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  return asset ? { uri: asset.uri, name: asset.name } : null;
}
