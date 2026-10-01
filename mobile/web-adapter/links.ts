import type { Send } from "./bridge.js";

export function installLinks(win: Window, doc: Document, send: Send): void {
  win.open = (url?: string | URL, _target?: string, _features?: string): null => {
    const href = url == null ? "" : String(url);
    if (/^https?:\/\//.test(href)) {
      send({ v: 1, type: "openExternal", url: href });
    }
    return null;
  };

  doc.addEventListener(
    "click",
    (ev) => {
      const a = (ev.target as Element).closest<HTMLAnchorElement>("a[target='_blank']");
      if (a == null) return;
      const href = a.href;
      if (!/^https?:\/\//.test(href)) return;
      ev.preventDefault();
      send({ v: 1, type: "openExternal", url: href });
    },
    true,
  );
}
