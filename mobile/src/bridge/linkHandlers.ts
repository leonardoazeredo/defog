import { decideNavigation, shouldOpenWindowExternally } from "./navigationPolicy.js";
import { openLink } from "./openLink.js";

// The two WebView callbacks that can send a link out of the app, apart from the page's own `openExternal` message. Kept
// apart from WebShell so the wiring to openLink can be tested without rendering a WebView.
export function createLinkHandlers(deps: {
  initialLoadDone: () => boolean;
  open: (url: string) => Promise<unknown>;
  notify: (text: string) => void;
}): {
  onShouldStartLoad(event: { url: string }): boolean;
  onOpenWindow(event: { nativeEvent: { targetUrl: string } }): void;
} {
  return {
    onShouldStartLoad(event) {
      const decision = decideNavigation(event.url, deps.initialLoadDone());
      if (decision === "external") void openLink(event.url, deps.open, deps.notify);
      return decision === "allow";
    },
    onOpenWindow(event) {
      const url = event.nativeEvent.targetUrl;
      if (shouldOpenWindowExternally(url)) void openLink(url, deps.open, deps.notify);
    },
  };
}
