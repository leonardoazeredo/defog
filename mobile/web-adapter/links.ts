import { ORIGIN } from "../src/bridge/protocol.js";
import type { Send } from "./bridge.js";

const PAGE_ORIGIN = new URL(ORIGIN).origin;

export function installLinks(win: Window, doc: Document, send: Send): void {
  win.open = (url?: string | URL, _target?: string, _features?: string): null => {
    const href = url == null ? "" : String(url);
    if (/^https?:\/\//.test(href)) {
      send({ v: 1, type: "openExternal", url: href });
    }
    return null;
  };

  // Stopping the click here keeps the WebView from starting a navigation at all: onShouldStartLoadWithRequest answers on the
  // JS thread and the native side lets the load through when the answer is late (#138). Capture phase, because Leaflet's
  // controls stop propagation on their own containers.
  const intercept = (ev: Event): void => {
    if (!(ev.target instanceof Element)) return;
    const a = ev.target.closest("a[href]");
    if (a == null) return;
    let url: URL;
    try {
      url = new URL(a.getAttribute("href") ?? "", doc.baseURI);
    } catch {
      ev.preventDefault();
      return;
    }
    // A blob URL is an export download that loads nothing, and a link that differs from the document base only in its
    // fragment stays in the document. Any other same-origin link (path or query) would be a real load of the origin that
    // reaches the late native answer, so it is stopped here and opens nothing: once the page has loaded, decideNavigation
    // blocks the origin too.
    if (url.origin === PAGE_ORIGIN) {
      const here = new URL(doc.baseURI);
      if (
        url.protocol !== "blob:" &&
        (url.pathname !== here.pathname || url.search !== here.search)
      ) {
        ev.preventDefault();
      }
      return;
    }
    ev.preventDefault();
    if (url.protocol === "https:" || url.protocol === "http:") {
      send({ v: 1, type: "openExternal", url: url.href });
    }
  };
  doc.addEventListener("click", intercept, true);
  // A middle-click fires auxclick and not click, so the click listener alone would miss it.
  doc.addEventListener("auxclick", intercept, true);
}
