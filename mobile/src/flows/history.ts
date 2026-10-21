import { type NativeToWeb, TRACK_CHUNK_POINTS } from "../bridge/protocol.js";
import { COPY } from "../copy.js";
import type { ActivityStore } from "../history/types.js";

export interface HistoryDeps {
  activities: Pick<ActivityStore, "list" | "get" | "delete">;
  send(msg: NativeToWeb): void;
}

export interface HistoryFlow {
  /** Sends the activity summaries, newest first. Never rejects. */
  publish(): Promise<void>;
  /** Sends one activity's track in chunks. Never rejects. */
  needTrack(id: string): Promise<void>;
  /** Deletes the activity, then publishes the rest. Never rejects. */
  deleteActivity(id: string): Promise<void>;
}

function warn(what: string, e: unknown): void {
  console.warn(`crossfog: history ${what}`, e instanceof Error ? e.name : "unknown");
}

export function createHistoryFlow(deps: HistoryDeps): HistoryFlow {
  const { activities, send } = deps;

  async function publish(): Promise<void> {
    try {
      send({ v: 1, type: "activities", items: await activities.list() });
    } catch (e) {
      warn("could not list the activities", e);
    }
  }

  return {
    publish,

    async needTrack(id) {
      try {
        const activity = await activities.get(id);
        if (!activity) return;
        const { track } = activity;
        // An empty track still needs one message: the page counts chunks, and `total` is at least 1.
        const total = Math.max(1, Math.ceil(track.length / TRACK_CHUNK_POINTS));
        for (let index = 0; index < total; index++) {
          const points = track.slice(index * TRACK_CHUNK_POINTS, (index + 1) * TRACK_CHUNK_POINTS);
          send({ v: 1, type: "track", activityId: id, index, total, points });
        }
      } catch (e) {
        warn("could not read a track", e);
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
