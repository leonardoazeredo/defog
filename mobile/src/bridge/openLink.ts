import { COPY } from "../copy.js";

// Opening can fail, for example when no app can handle the URL. Neither the message nor the URL is logged or shown: both can
// carry what the user was reading.
export async function openLink(
  url: string,
  open: (url: string) => Promise<unknown>,
  notify: (text: string) => void,
): Promise<void> {
  try {
    await open(url);
  } catch (e) {
    console.warn("crossfog: open link failed", e instanceof Error ? e.name : "unknown");
    notify(COPY.openLinkFailed);
  }
}
