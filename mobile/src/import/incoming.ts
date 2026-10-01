import type { SourceFile } from "../fog/store.js";

export interface ShareFileLike {
  path: string;
  fileName?: string | null;
  mimeType?: string | null;
}

export function acceptIncoming(name: string): boolean {
  return /\.zip$/i.test(name);
}

export function nameFromFileUrl(url: string): string {
  const path = new URL(url).pathname;
  const last = path.split("/").at(-1) ?? "";
  return decodeURIComponent(last);
}

export function fileFromSystemPath(path: string): SourceFile | null {
  if (!path.startsWith("file://")) return null;
  return { uri: path, name: nameFromFileUrl(path) };
}

export function filesFromShareIntent(files: ShareFileLike[]): SourceFile[] {
  return files.map((f) => {
    const uri = f.path.startsWith("file://") ? f.path : `file://${f.path}`;
    const name = f.fileName ?? nameFromFileUrl(uri);
    return { uri, name };
  });
}

export function isDisposableCopy(uri: string, roots: { cache: string; inbox: string }): boolean {
  return uri.startsWith(roots.cache) || uri.startsWith(roots.inbox);
}
