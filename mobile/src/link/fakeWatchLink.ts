import { z } from "zod";
import type { RouteRecord } from "../bridge/protocol.js";
import type {
  ActivityOffer,
  LinkStatus,
  PendingActivity,
  WatchLink,
  WatchLinkEvents,
} from "./types.js";

export interface FakeWatchLink extends WatchLink {
  /** The watch handed an activity to the phone's staging store. */
  stage(offer: ActivityOffer): void;
  /**
   * Counts one staged item the native side cannot read, as after a lost staging alias. It is never
   * listed; `id` only lets `release` drop it.
   */
  stageUnreadable(id: string): void;
  setStatus(status: LinkStatus): void;
  /** The watch saved a queued route. */
  confirmRoute(routeId: string): void;
  /** The latest route queued under each id; `confirmRoute` does not remove it. */
  queued(): RouteRecord[];
  /** Every UUID passed to `release`, in order, known or not; a malformed id is refused and not recorded. */
  released(): string[];
}

type Listeners = { [E in keyof WatchLinkEvents]: Set<(payload: WatchLinkEvents[E]) => void> };

export function createFakeWatchLink(): FakeWatchLink {
  const staged = new Map<string, ActivityOffer>();
  const unreadable = new Set<string>();
  const routes = new Map<string, RouteRecord>();
  const releasedIds: string[] = [];
  let currentStatus: LinkStatus = { paired: false, reachable: false };
  const listeners: Listeners = {
    activityStaged: new Set(),
    linkStatus: new Set(),
    routeSaved: new Set(),
  };

  function emit<E extends keyof WatchLinkEvents>(event: E, payload: WatchLinkEvents[E]) {
    for (const fn of [...listeners[event]]) fn(payload);
  }

  // Copies throughout, so a caller cannot change what the next call returns.
  const withoutFile = ({
    activityId,
    routeId,
    travelMode,
    encoderVersion,
  }: ActivityOffer): PendingActivity => ({
    activityId,
    ...(routeId === undefined ? {} : { routeId }),
    travelMode,
    encoderVersion,
  });

  return {
    async pair() {
      currentStatus = { paired: true, reachable: false };
      emit("linkStatus", { ...currentStatus });
    },
    async status() {
      return { ...currentStatus };
    },
    async queueRoute(route) {
      routes.set(route.id, structuredClone(route));
    },
    async pendingActivities() {
      return [...staged.values()].map(withoutFile);
    },
    async unreadableActivities() {
      return unreadable.size;
    },
    async readActivity(id) {
      const offer = staged.get(id);
      if (!offer) throw new Error("activity is not staged");
      return { ...offer };
    },
    async release(id) {
      // The native side answers ERR_INVALID_ID for an id that is not a UUID (it also refuses the nil
      // and max UUIDs, which this lets through); a flow that passes a bad id must fail here too.
      if (!z.uuid().safeParse(id).success) throw new Error("invalid id");
      releasedIds.push(id);
      staged.delete(id);
      unreadable.delete(id);
    },
    on(event, fn) {
      const set = listeners[event] as Set<typeof fn>;
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    stage(offer) {
      staged.set(offer.activityId, { ...offer });
      emit("activityStaged", { activityId: offer.activityId });
    },
    stageUnreadable(id) {
      unreadable.add(id);
    },
    setStatus(status) {
      currentStatus = { ...status };
      emit("linkStatus", { ...currentStatus });
    },
    confirmRoute(routeId) {
      if (!routes.has(routeId)) throw new Error("route is not queued");
      emit("routeSaved", { routeId });
    },
    queued: () => [...routes.values()].map((r) => structuredClone(r)),
    released: () => [...releasedIds],
  };
}
