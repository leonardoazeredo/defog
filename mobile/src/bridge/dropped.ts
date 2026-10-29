import type { DroppedMessage, NativeToWeb } from "./protocol.js";

// A dropped sendRoute whose route id is a valid UUID is answered as failed, so the Send chip does not
// stay blank; a dropped exportBinary with a valid export id goes to `abandonExport`, which drops that export
// and tells the page. Any other drop gets no answer and the page times it out (REPLY_TIMEOUT_MS in
// app/src/history.js, REPLY_MS in app/src/fowExport.js).
export function reportDropped(
  drop: DroppedMessage,
  send: (msg: NativeToWeb) => void,
  abandonExport: (exportId: string) => void,
): void {
  // Type and key paths only: the values are routes and positions, which must not reach logs.
  console.warn("crossfog: dropped invalid message", drop.type ?? "unknown", drop.paths.join(" "));
  if (drop.routeId !== null) {
    send({ v: 1, type: "routeStatus", routeId: drop.routeId, state: "failed" });
  }
  if (drop.exportId !== null) abandonExport(drop.exportId);
}
