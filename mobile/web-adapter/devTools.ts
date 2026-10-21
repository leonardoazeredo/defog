import type { Send } from "./bridge.js";
import type { FogCache } from "./fogCache.js";

export function installDevTools(doc: Document, cache: FogCache, send: Send): void {
  const addButton = (label: string, onClick: () => void) => {
    const b = doc.createElement("button");
    b.textContent = label;
    b.dataset.crossfogDev = "";
    b.addEventListener("click", onClick);
    doc.body.appendChild(b);
  };
  addButton("Dev: drop fog cache", () => void cache.clearAll());
  addButton("Dev: add activity from GPX", () => send({ v: 1, type: "devAddActivity" }));
}
