import { z } from "zod";
import type { RouteRecord } from "../bridge/protocol.js";

export const linkStatusSchema = z.object({ paired: z.boolean(), reachable: z.boolean() });

const uuid = z.uuid();
const travelMode = z.string().min(1).max(32);
const encoderVersion = z.string().min(1).max(64);

/** What the list of staged activities carries; the file stays behind `readActivity`. */
export const pendingActivitySchema = z.object({
  activityId: uuid,
  routeId: uuid.optional(),
  travelMode,
  encoderVersion,
});

export const activityOfferSchema = pendingActivitySchema.extend({ gpx: z.string().min(1) });

export type LinkStatus = z.infer<typeof linkStatusSchema>;
export type PendingActivity = z.infer<typeof pendingActivitySchema>;
export type ActivityOffer = z.infer<typeof activityOfferSchema>;

export interface WatchLinkEvents {
  activityStaged: { activityId: string };
  linkStatus: LinkStatus;
  routeSaved: { routeId: string };
}

export interface WatchLink {
  pair(qrPayload: string): Promise<void>;
  status(): Promise<LinkStatus>;
  /** Persists the route on the phone, across the app closing, until the watch confirms it with `routeSaved`. Nothing delivers it yet. */
  queueRoute(route: RouteRecord): Promise<void>;
  pendingActivities(): Promise<PendingActivity[]>;
  /**
   * How many staged items cannot be decrypted, parsed or matched to their file name; they are never
   * listed and stay staged.
   */
  unreadableActivities(): Promise<number>;
  /** Rejects for an id that is not staged. */
  readActivity(id: string): Promise<ActivityOffer>;
  /** Only after the activity is committed to the phone's activity store. A well-formed id that is not staged is a no-op; a malformed id rejects. */
  release(id: string): Promise<void>;
  /** Returns the function that removes the listener. */
  on<E extends keyof WatchLinkEvents>(
    event: E,
    fn: (payload: WatchLinkEvents[E]) => void,
  ): () => void;
}
