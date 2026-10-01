import type { NativeToWeb, WebToNative } from "../src/bridge/protocol.js";
import { encode, parseNativeToWeb } from "../src/bridge/protocol.js";

export type Send = (msg: WebToNative) => void;

export function createSend(win: Window): Send {
  return (msg) => {
    if (win.ReactNativeWebView == null) {
      console.warn("crossfog: ReactNativeWebView not available");
      return;
    }
    win.ReactNativeWebView.postMessage(encode(msg));
  };
}

export function onNativeMessage(
  win: Window,
  doc: Document,
  handler: (msg: NativeToWeb) => void,
): () => void {
  const seen = new WeakSet<Event>();
  const handle = (ev: Event) => {
    if (seen.has(ev)) return;
    seen.add(ev);
    if (!(ev instanceof MessageEvent)) return;
    const msg = parseNativeToWeb(ev.data as string);
    if (msg === null) {
      console.warn("crossfog: dropped invalid message");
      return;
    }
    handler(msg);
  };
  win.addEventListener("message", handle);
  doc.addEventListener("message", handle);
  return () => {
    win.removeEventListener("message", handle);
    doc.removeEventListener("message", handle);
  };
}
