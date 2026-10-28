import { type NativeToWeb, type RouteRecord, TRACK_CHUNK_POINTS } from "../bridge/protocol.js";
import { COPY } from "../copy.js";
import type { ActivityStore, RouteStore } from "../history/types.js";

export interface HistoryDeps {
  activities: Pick<ActivityStore, "list" | "get" | "delete">;
  routes: Pick<RouteStore, "get">;
  send(msg: NativeToWeb): void;
}

export interface HistoryFlow {
  /** Sends the activity summaries, newest first. Never rejects. */
  publish(): Promise<void>;
  /** Sends one activity's track in chunks, or `trackUnavailable` when the activity is gone or cannot be read. Never rejects. */
  needTrack(id: string): Promise<void>;
  /** Deletes the activity, then publishes the rest. Never rejects. */
  deleteActivity(id: string): Promise<void>;
}

function warn(what: string, e: unknown): void {
  console.warn(`crossfog: history ${what}`, e instanceof Error ? e.name : "unknown");
}

export function createHistoryFlow(deps: HistoryDeps): HistoryFlow {
  const { activities, routes, send } = deps;

  async function publish(): Promise<void> {
    try {
      send({ v: 1, type: "activities", items: await activities.list() });
    } catch (e) {
      warn("could not list the activities", e);
    }
  }

  async function trackMessages(id: string): Promise<NativeToWeb[]> {
    const activity = await activities.get(id);
    // Deleted since the page listed it: without an answer the detail shows only its timeout line, not why.
    if (!activity) return [{ v: 1, type: "trackUnavailable", activityId: id, reason: "notFound" }];
    const { track } = activity;
    // The history panel draws the route beside the track; a route that cannot be read costs only that line.
    let route: { coords: RouteRecord["coords"] } | undefined;
    if (activity.routeId != null) {
      try {
        const stored = await routes.get(activity.routeId);
        if (stored) route = { coords: stored.coords };
      } catch (e) {
        warn("could not read a followed route", e);
      }
    }
    // An empty track still needs one message: the page counts chunks, and `total` is at least 1.
    const total = Math.max(1, Math.ceil(track.length / TRACK_CHUNK_POINTS));
    const messages: NativeToWeb[] = [];
    for (let index = 0; index < total; index++) {
      const points = track.slice(index * TRACK_CHUNK_POINTS, (index + 1) * TRACK_CHUNK_POINTS);
      messages.push({
        v: 1,
        type: "track",
        activityId: id,
        index,
        total,
        points,
        ...(index === 0 && route ? { route } : {}),
      });
    }
    return messages;
  }

  return {
    publish,

    async needTrack(id) {
      let messages: NativeToWeb[];
      try {
        messages = await trackMessages(id);
      } catch (e) {
        warn("could not read a track", e);
        messages = [{ v: 1, type: "trackUnavailable", activityId: id, reason: "readFailed" }];
      }
      try {
        for (const msg of messages) send(msg);
      } catch (e) {
        warn("could not send a track", e);
      }
    },

    async deleteActivity(id) {
      try {
        await activities.delete(id);
      } catch (e) {
        warn("could not delete an activity", e);
        send({ v: 1, type: "notice", text: COPY.activityDeleteFailed });
        return;
      }
      await publish();
    },
  };
}
