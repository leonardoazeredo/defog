import { useShareIntentContext } from "expo-share-intent";
import { useEffect } from "react";
import { filesFromShareIntent } from "./import/incoming.js";
import { enqueueIncoming } from "./import/incomingQueue.js";

export function ShareIntentBridge(): null {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();

  useEffect(() => {
    if (!hasShareIntent || !shareIntent.files) return;
    const files = filesFromShareIntent(shareIntent.files);
    for (const file of files) enqueueIncoming(file);
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  return null;
}
