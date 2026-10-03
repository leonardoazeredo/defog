import { z } from "zod";
import { createSend, onNativeMessage } from "./bridge.js";
import { installDevTools } from "./devTools.js";
import { installDownloads } from "./downloads.js";
import { openFogCache } from "./fogCache.js";
import { installImportButtons } from "./importButtons.js";
import { installLinks } from "./links.js";
import { assignFilesWithDataTransfer, installOutcomeHooks, loadCopy } from "./loader.js";
import { createSession, createStatusActions } from "./session.js";
import { createStatus } from "./status.js";

z.config({ jitless: true });

const send = createSend(window);

installLinks(window, document, send);
installDownloads(window, document, send);

async function toHex(buf: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (CRYPTO_SUBTLE) {
    const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as Uint8Array<ArrayBuffer>);
    return toHex(buf);
  }
  // Fallback for platforms without crypto.subtle (old Android WebView).
  // @noble/hashes is a build-time optional dep; if CRYPTO_SUBTLE is false it must be installed.
  const { sha256 } = await import("@noble/hashes/sha256");
  const { bytesToHex } = await import("@noble/hashes/utils");
  return bytesToHex(sha256(bytes));
}

document.addEventListener("DOMContentLoaded", async () => {
  const brandName = document.getElementById("brandName");
  if (brandName != null) brandName.textContent = "CROSS THE FOG";

  installImportButtons(document, send);

  const hooks = installOutcomeHooks(window);
  const cache = await openFogCache(indexedDB, CACHE_ENABLED);

  const zipInput = document.getElementById("zip") as HTMLInputElement;
  const load = (bytes: Uint8Array, name: string) =>
    loadCopy(bytes, name, { zipInput, hooks, assignFiles: assignFilesWithDataTransfer });

  const statusActions = createStatusActions(send);
  const status = createStatus(document, statusActions, Date.now);

  const session = createSession({
    send,
    cache,
    status,
    load,
    sha256Hex,
    handleBack: () => {
      const sidebar = document.getElementById("sidebar");
      if (sidebar == null || !sidebar.classList.contains("open")) return false;
      sidebar.classList.remove("open");
      return true;
    },
  });

  if (__CROSSFOG_DEV_TOOLS__) {
    installDevTools(document, cache);
  }

  onNativeMessage(window, document, (msg) => void session.onMessage(msg));

  send({ v: 1, type: "ready" });
});
