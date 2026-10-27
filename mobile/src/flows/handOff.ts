import { activityStats, type ParsedGpx } from "../history/gpx.js";
import type { Activity, ActivityStore } from "../history/types.js";
import type { WatchLink } from "../link/types.js";

interface HandOffResult {
  /** Offers the store did not know yet. */
  stored: number;
  /** Staged copies cleared; includes offers whose activity was already in the store. */
  released: number;
}

export interface HandOffDeps {
  link: Pick<WatchLink, "pendingActivities" | "readActivity" | "release">;
  activities: Pick<ActivityStore, "add">;
  parseGpx(text: string): ParsedGpx;
  now(): number;
}

export interface HandOffFlow {
  /** Never rejects: an offer that cannot be handled stays staged for the next run. */
  run(): Promise<HandOffResult>;
  /**
   * Runs `fn` with the hand-off held: no offer starts, and an activity committed meanwhile keeps its
   * staged copy. The caller runs the hand-off again once `fn` settles.
   */
  hold<R>(fn: () => Promise<R>): Promise<R>;
}

// Only the error name is logged; messages and ids can tie a walk to a time and a place.
function warn(what: string, e: unknown): void {
  console.warn(`crossfog: hand-off ${what}`, e instanceof Error ? e.name : "unknown");
}

export function createHandOffFlow(deps: HandOffDeps): HandOffFlow {
  const { link, activities } = deps;
  let held = 0;

  async function handle(
    activityId: string,
  ): Promise<{ stored: boolean; released: boolean } | null> {
    let activity: Activity;
    try {
      const offer = await link.readActivity(activityId);
      // The record is filed under the offer's id but released under the staged id; they must be one.
      if (offer.activityId !== activityId) throw new Error("offer does not match its staged id");
      const parsed = deps.parseGpx(offer.gpx);
      activity = {
        id: offer.activityId,
        travelMode: offer.travelMode,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        ...(offer.routeId === undefined ? {} : { routeId: offer.routeId }),
        stats: activityStats(parsed),
        gpx: offer.gpx,
        track: parsed.points,
        receivedAt: new Date(deps.now()).toISOString(),
        encoderVersion: offer.encoderVersion,
      };
    } catch (e) {
      warn("could not read an offer", e);
      return null;
    }

    let stored: boolean;
    try {
      stored = (await activities.add(activity)).stored;
    } catch (e) {
      warn("could not store an activity", e);
      return null;
    }

    // A restore may have replaced the database this commit went to; the staged copy stays, so the
    // run after the restore stores the activity wherever it is missing and releases it.
    if (held > 0) return { stored, released: false };
    // Only after the commit: a crash from here on leaves the copy staged, and the next run finds the
    // activity known, stores nothing and releases.
    try {
      await link.release(activityId);
    } catch (e) {
      warn("could not release an activity", e);
      return { stored, released: false };
    }
    return { stored, released: true };
  }

  async function pass(): Promise<HandOffResult> {
    const result = { stored: 0, released: 0 };
    let pending: Awaited<ReturnType<typeof link.pendingActivities>>;
    try {
      pending = await link.pendingActivities();
    } catch (e) {
      warn("could not list the staged offers", e);
      return result;
    }
    for (const { activityId } of pending) {
      if (held > 0) break;
      const outcome = await handle(activityId);
      if (!outcome) continue;
      if (outcome.stored) result.stored++;
      if (outcome.released) result.released++;
    }
    return result;
  }

  // `run` fires at start and on every `activityStaged`; passes must not overlap, and an offer staged
  // during a pass needs a pass that starts after it, which the one waiting pass provides.
  let active: Promise<HandOffResult> | null = null;
  let waiting: Promise<HandOffResult> | null = null;
  function run(): Promise<HandOffResult> {
    if (!active) {
      active = pass().finally(() => {
        active = null;
      });
      return active;
    }
    waiting ??= active.then(() => {
      waiting = null;
      return run();
    });
    return waiting;
  }

  async function hold<R>(fn: () => Promise<R>): Promise<R> {
    held++;
    try {
      return await fn();
    } finally {
      held--;
    }
  }

  return { run, hold };
}
