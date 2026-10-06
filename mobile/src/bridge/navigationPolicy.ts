export { ORIGIN } from "./protocol.js";

import { ORIGIN } from "./protocol.js";

export type NavigationDecision = "allow" | "block" | "external";

export function decideNavigation(url: string, initialLoadDone: boolean): NavigationDecision {
  if (!initialLoadDone) {
    if (url === ORIGIN || url === "about:blank") return "allow";
    return "block";
  }
  if (url.startsWith("https://") || url.startsWith("http://")) {
    if (url.startsWith(ORIGIN)) return "block";
    return "external";
  }
  return "block";
}

export function shouldOpenWindowExternally(targetUrl: string): boolean {
  return decideNavigation(targetUrl, true) === "external";
}
