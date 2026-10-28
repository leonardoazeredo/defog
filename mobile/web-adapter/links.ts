import { ORIGIN } from "../src/bridge/protocol.js";
import type { Send } from "./bridge.js";

const PAGE_ORIGIN = new URL(ORIGIN).origin;

// What the system browser should open for an href, resolved the way a click resolves it, or null when it stays in the app
// (same origin, or not a web scheme) or cannot be parsed.
function foreignWebUrl(href: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.origin === PAGE_ORIGIN) return null;
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}

export function installLinks(win: Window, doc: Document, send: Send): void {
  win.open = (url?: string | URL, _target?: string, _features?: string): null => {
    // An empty URL is about:blank, not the document's own address.
    const href = url == null ? "" : String(url);
    const external = href === "" ? null : foreignWebUrl(href, doc.baseURI);
    if (external != null) send({ v: 1, type: "openExternal", url: external });
    return null;
  };

  // Stopping the click here keeps the WebView from starting a navigation at all: onShouldStartLoadWithRequest answers on the
  // JS thread and the native side lets the load through when the answer is late (#138). Capture phase, because Leaflet's
  // controls stop propagation on their own containers.
  const intercept = (ev: Event): void => {
    // auxclick also fires for the right button, which is no request to leave the app.
    if (ev instanceof MouseEvent && ev.type === "auxclick" && ev.button !== 1) return;
    if (!(ev.target instanceof Element)) return;
    const a = ev.target.closest("a[href]");
    if (a == null) return;
    const href = (a.getAttribute("href") ?? "").trim();
    let url: URL;
    try {
      url = new URL(href, doc.baseURI);
    } catch {
      ev.preventDefault();
      return;
    }
    // A blob URL is an export download that loads nothing, and a fragment change stays in the document. Any other
    // same-origin link is a real load of the origin that reaches the late native answer, so it is stopped and opens
    // nothing, whatever its target; once the page has loaded, decideNavigation blocks the origin too. An href with no
    // fragment that resolves to the page itself ("" or "?") is a reload, not a fragment change.
    if (url.origin === PAGE_ORIGIN) {
      const here = new URL(doc.baseURI);
      const staysHere =
        url.protocol === "blob:" ||
        (url.pathname === here.pathname &&
          url.search === here.search &&
          (url.hash !== "" || href.startsWith("#")));
      if (!staysHere) ev.preventDefault();
      return;
    }
    ev.preventDefault();
    const external = foreignWebUrl(href, doc.baseURI);
    if (external != null) send({ v: 1, type: "openExternal", url: external });
  };
  doc.addEventListener("click", intercept, true);
  // A middle-click fires auxclick and not click, so the click listener alone would miss it.
  doc.addEventListener("auxclick", intercept, true);
}
