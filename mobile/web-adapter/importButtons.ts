import type { Send } from "./bridge.js";

export function installImportButtons(doc: Document, send: Send): void {
  const zipInput = doc.getElementById("zip");
  const folderInput = doc.getElementById("folder");
  const zipLabel = zipInput?.closest("label");
  const folderLabel = folderInput?.closest<HTMLElement>("label");

  if (folderLabel != null) folderLabel.style.display = "none";
  if (zipLabel == null) return;

  doc.addEventListener(
    "click",
    (ev) => {
      if (!zipLabel.contains(ev.target as Node)) return;
      ev.preventDefault();
      ev.stopPropagation();
      send({ v: 1, type: "pickBackup" });
    },
    true,
  );
}
