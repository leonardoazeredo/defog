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
  dest.write(file.text);
  const uti = utiFor(file.filename);
  await Sharing.shareAsync(dest.uri, {
    mimeType: file.mime,
    ...(uti !== undefined && { UTI: uti }),
    dialogTitle: file.filename,
  });
}

export function makeReleaseSource(roots: { cache: string; inbox: string }) {
  return async function releaseSource(uri: string): Promise<void> {
    if (isDisposableCopy(uri, roots)) {
      const f = new File(uri);
      if (f.exists) f.delete();
    }
  };
}
