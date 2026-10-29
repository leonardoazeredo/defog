import { COPY } from "../copy.js";
import type { DroppedMessage, NativeToWeb } from "./protocol.js";

// A dropped message the page waits on is answered when its id is valid: sendRoute as failed (so the Send
// chip does not stay blank), deleteActivity with a notice (the card has closed and the row stays),
// needTrack with trackUnavailable (the detail stops waiting), exportBinary through `abandonExport`, which
// drops that export and tells the page. Any other drop gets no answer and the page times it out
// (REPLY_TIMEOUT_MS in app/src/history.js, REPLY_MS in app/src/fowExport.js).
export function reportDropped(
  drop: DroppedMessage,
  send: (msg: NativeToWeb) => void,
  abandonExport: (exportId: string) => void,
): void {
  // Type and key paths only: the values are routes and positions, which must not reach logs. An unknown
  // type is any text the page wrote, so only the reason it was unreadable is logged.
  console.warn(
    "crossfog: dropped invalid message",
    drop.type ?? `unknown:${drop.reason}`,
    drop.paths.join(" "),
  );
  switch (drop.type) {
    case "sendRoute":
      if (drop.routeId !== null) {
        send({ v: 1, type: "routeStatus", routeId: drop.routeId, state: "failed" });
      }
      break;
    case "exportBinary":
      if (drop.exportId !== null) abandonExport(drop.exportId);
      break;
    case "deleteActivity":
      if (drop.activityId !== null) {
        send({ v: 1, type: "notice", text: COPY.activityDeleteFailed });
      }
      break;
    case "needTrack":
      if (drop.activityId !== null) {
        send({ v: 1, type: "trackUnavailable", activityId: drop.activityId, reason: "readFailed" });
      }
      break;
    default:
      break;
  }
}
