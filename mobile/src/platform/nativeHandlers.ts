import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { safeExportName, utiFor } from "../bridge/exportFile.js";
import { isDisposableCopy } from "../import/incoming.js";

export async function shareExport(file: {
  filename: string;
  mime: string;
  text: string;
}): Promise<void> {
  const safe = safeExportName(file.filename);
  const exportsDir = new Directory(Paths.cache, "exports");
  if (!exportsDir.exists) exportsDir.create();
  const dest = new File(exportsDir, safe);
  await dest.write(file.text);
  const uti = utiFor(file.filename);
  try {
    await Sharing.shareAsync(dest.uri, {
      mimeType: file.mime,
      ...(uti !== undefined && { UTI: uti }),
      dialogTitle: file.filename,
    });
  } finally {
    // The copy holds the route in plaintext, so it is removed once the share sheet closes; a failure to
    // remove it must not replace the share's own result.
    try {
      if (dest.exists) dest.delete();
    } catch (e) {
      console.warn("crossfog: share copy not removed", e instanceof Error ? e.name : "unknown");
    }
  }
}

/** Removes the share copies a crash left behind. */
export function clearShareCopies(): void {
  try {
    const dir = new Directory(Paths.cache, "exports");
    if (dir.exists) dir.delete();
  } catch (e) {
    console.warn("crossfog: share copies not removed", e instanceof Error ? e.name : "unknown");
  }
}

export function makeReleaseSource(roots: { cache: string; inbox: string }) {
  return async function releaseSource(uri: string): Promise<void> {
    if (isDisposableCopy(uri, roots)) {
      const f = new File(uri);
      if (f.exists) f.delete();
    }
  };
}
