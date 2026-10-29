import type { Send } from "./bridge.js";
import type { FogCache } from "./fogCache.js";

// Pinned on screen so a Maestro tap always reaches them: at the page foot the bottom sheet and the
// gesture bar cover them. These buttons exist in e2e builds only.
const BAR_STYLE =
  "position:fixed;top:56px;right:4px;z-index:2147483647;display:flex;flex-direction:column;gap:4px;";

export function installDevTools(doc: Document, cache: FogCache, send: Send): void {
  const bar = doc.createElement("div");
  bar.dataset.crossfogDevBar = "";
  bar.style.cssText = BAR_STYLE;
  const addButton = (label: string, onClick: () => void) => {
    const b = doc.createElement("button");
    b.textContent = label;
    b.dataset.crossfogDev = "";
    b.addEventListener("click", onClick);
    bar.appendChild(b);
  };
  addButton("Dev: drop fog cache", () => void cache.clearAll());
  addButton("Dev: add activity from GPX", () => send({ v: 1, type: "devAddActivity" }));
  doc.body.appendChild(bar);
}
