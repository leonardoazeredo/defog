import { inspectWebToNative, type WebToNative } from "../../src/bridge/protocol.js";

// The app itself only ever calls inspectWebToNative, which says why a message was dropped.
export function parseWebToNative(raw: string): WebToNative | null {
  const result = inspectWebToNative(raw);
  return result.ok ? result.msg : null;
}
