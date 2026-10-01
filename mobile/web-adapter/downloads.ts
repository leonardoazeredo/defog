import type { Send } from "./bridge.js";

export function installDownloads(win: Window, doc: Document, send: Send): void {
  const blobMap = new Map<string, Blob>();

  const g = win as unknown as typeof globalThis;
  // biome-ignore lint/suspicious/noExplicitAny: patching static method requires bypassing type constraints
  const urlCtor = g.URL as any;
  const origCreate: (obj: Blob | MediaSource) => string = urlCtor.createObjectURL?.bind(g.URL);
  urlCtor.createObjectURL = (obj: Blob | MediaSource): string => {
    const url = origCreate(obj);
    if (obj instanceof Blob) blobMap.set(url, obj);
    return url;
  };

  doc.addEventListener(
    "click",
    (ev) => {
      const a = (ev.target as Element).closest<HTMLAnchorElement>("a[download]");
      if (a == null) return;
      const blob = blobMap.get(a.href);
      if (blob == null) return;
      ev.preventDefault();
      void blob.text().then((text) => {
        send({ v: 1, type: "export", filename: a.download, mime: blob.type, text });
      });
    },
    true,
  );
}
