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
  setStatus(status: LinkStatus): void;
  /** The watch saved a queued route. */
  confirmRoute(routeId: string): void;
  /** The latest route queued under each id; `confirmRoute` does not remove it. */
  queued(): RouteRecord[];
  /** Every id passed to `release`, in order, known or not. */
  released(): string[];
}

type Listeners = { [E in keyof WatchLinkEvents]: Set<(payload: WatchLinkEvents[E]) => void> };

export function createFakeWatchLink(): FakeWatchLink {
  const staged = new Map<string, ActivityOffer>();
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
    async readActivity(id) {
      const offer = staged.get(id);
      if (!offer) throw new Error("activity is not staged");
      return { ...offer };
    },
    async release(id) {
      releasedIds.push(id);
      staged.delete(id);
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
