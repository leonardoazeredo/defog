import type { FogCache } from "./fogCache.js";

export function installDevTools(doc: Document, cache: FogCache): void {
  const b = doc.createElement("button");
  b.textContent = "Dev: drop fog cache";
  b.dataset.crossfogDev = "";
  b.addEventListener("click", () => void cache.clearAll());
  doc.body.appendChild(b);
}
