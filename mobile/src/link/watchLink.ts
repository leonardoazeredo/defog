import { z } from "zod";
import type { RouteRecord } from "../bridge/protocol.js";
import { localDateTime } from "../localDate.js";
import * as native from "../platform/watchLinkModule.js";
import {
  activityOfferSchema,
  linkStatusSchema,
  pendingActivitySchema,
  type WatchLink,
  type WatchLinkEvents,
} from "./types.js";

// Native values cross a trust boundary (offers come from the watch), so each one is parsed.
const eventSchemas: { [E in keyof WatchLinkEvents]: z.ZodType<WatchLinkEvents[E]> } = {
  activityStaged: z.object({ activityId: z.uuid() }),
  linkStatus: linkStatusSchema,
  routeSaved: z.object({ routeId: z.uuid() }),
};

// The watch lists a saved route under this name; a route has none of its own. Local time, as the
// day the rider lived it, while createdAt stays UTC on the wire. `timeZone` lets a test pin a zone
// without touching the process TZ; production omits it and gets device-local time.
export function routeName(route: RouteRecord, timeZone?: string): string {
  const { date, time } = localDateTime(Date.parse(route.createdAt), timeZone);
  return `Route ${date} ${time}`;
}

export function createNativeWatchLink(): WatchLink {
  return {
    async pair() {
      throw new Error("pairing arrives with the watch transport");
    },
    async status() {
      return linkStatusSchema.parse(await native.linkStatus());
    },
    async queueRoute(route) {
      await native.queueRoute(
        JSON.stringify({
          routeId: route.id,
          name: routeName(route),
          travelMode: route.travelMode,
          createdAt: route.createdAt,
          gpx: route.gpx,
        }),
      );
    },
    async pendingActivities() {
      const entries = z.array(z.unknown()).parse(await native.pendingActivities());
      // One malformed entry must not hide the others. It is dropped from this list with a warning and
      // is not deleted from the native store.
      return entries.flatMap((entry) => {
        const parsed = pendingActivitySchema.safeParse(entry);
        if (parsed.success) return [parsed.data];
        console.warn("watch link listed a malformed pending activity");
        return [];
      });
    },
    async readActivity(id) {
      const text = await native.readActivity(id);
      let offer: unknown;
      try {
        offer = JSON.parse(text);
      } catch {
        // A JSON engine may quote the input in its error, and the input is a walk's track.
        throw new Error("watch link returned an unreadable activity");
      }
      return activityOfferSchema.parse(offer);
    },
    release: (id) => native.releaseActivity(id),
    on(event, fn) {
      const schema = eventSchemas[event];
      return native.onLinkEvent(event, (payload) => {
        const parsed = schema.safeParse(payload);
        // Nothing of the payload is logged: an activity id ties a walk to a time.
        if (parsed.success) fn(parsed.data);
        else console.warn("watch link sent a malformed event");
      });
    },
  };
}
