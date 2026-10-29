import { reportDropped } from "./dropped.js";
import {
  inspectWebToNative,
  isTrustedSource,
  type NativeToWeb,
  type WebToNative,
} from "./protocol.js";

interface WebMessageDeps {
  send: (msg: NativeToWeb) => void;
  abandonExport: (exportId: string) => void;
  onMessage: (msg: WebToNative) => void | Promise<void>;
}

// Lives outside WebShell, which no unit test can render, so the step that hands a dropped message to
// reportDropped (and so keeps the page from waiting on it) can be tested. A message from another origin
// is silent: it gets no log and no answer.
export function createWebMessageHandler(
  deps: WebMessageDeps,
): (event: { url: string; data: string }) => void {
  return ({ url, data }) => {
    if (!isTrustedSource(url)) return;
    const parsed = inspectWebToNative(data);
    if (!parsed.ok) {
      reportDropped(parsed.drop, deps.send, deps.abandonExport);
      return;
    }
    void deps.onMessage(parsed.msg);
  };
}
