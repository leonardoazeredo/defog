import { z } from "zod";
import type { RouteRecord } from "../bridge/protocol.js";
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

// The watch lists a saved route under this name; a route has none of its own.
function routeName(route: RouteRecord): string {
  return `Route ${route.createdAt.slice(0, 10)}`;
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
      return z.array(pendingActivitySchema).parse(await native.pendingActivities());
    },
    async readActivity(id) {
      return activityOfferSchema.parse(JSON.parse(await native.readActivity(id)));
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
