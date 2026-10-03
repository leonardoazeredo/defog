import { getShareExtensionKey } from "expo-share-intent";
import { fileFromSystemPath } from "../src/import/incoming.js";
import { enqueueIncoming } from "../src/import/incomingQueue.js";

export function redirectSystemPath(args: { path: string; initial: boolean }): string {
  try {
    if (args.path.includes(`dataUrl=${getShareExtensionKey()}`)) return "/";
    const file = fileFromSystemPath(args.path);
    if (file) {
      enqueueIncoming(file);
      return "/";
    }
    return args.path;
  } catch {
    return "/";
  }
}
