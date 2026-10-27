import { describe, expect, it, vi } from "vitest";
import type { NativeToWeb } from "../../../src/bridge/protocol.js";
import { createFlows } from "../../../src/flows/compose.js";
import {
  createMemoryActivityStore,
  createMemoryRouteStore,
} from "../../../src/history/memoryStores.js";
import type { ActivityStore } from "../../../src/history/types.js";
import { createFakeWatchLink } from "../../../src/link/fakeWatchLink.js";
import { route } from "../history/fixtures.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GPX =
  '<gpx><trk><trkseg><trkpt lat="51.4769" lon="0.0005"><time>2026-03-01T10:00:00Z</time></trkpt></trkseg></trk></gpx>';

function setup() {
  const link = createFakeWatchLink();
  const activities = createMemoryActivityStore();
  const routes = createMemoryRouteStore();
  const sent: NativeToWeb[] = [];
  const flows = createFlows({ link, activities, routes, send: (m) => sent.push(m), now: () => 0 });
  return { link, activities, routes, sent, flows };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// A restore swaps the database file: the store from then on is a new one, without what the old held.
function swappableActivities(): { store: ActivityStore; swap(): void } {
  let current = createMemoryActivityStore();
  return {
    store: {
      add: (a) => current.add(a),
      list: () => current.list(),
      get: (id) => current.get(id),
      delete: (id) => current.delete(id),
    },
    swap() {
      current = createMemoryActivityStore();
    },
  };
}

function setupWithRestore(restore: (swap: () => void) => Promise<boolean>) {
  const link = createFakeWatchLink();
  const activities = swappableActivities();
  const sent: NativeToWeb[] = [];
  const flows = createFlows({
    link,
    activities: activities.store,
    routes: createMemoryRouteStore(),
    send: (m) => sent.push(m),
    backup: { backup: async () => {}, restore: () => restore(activities.swap) },
    now: () => 0,
  });
  return { link, activities: activities.store, sent, flows };
}

describe("composed flows", () => {
  it("hands off what is already staged when started and publishes the history", async () => {
    const { link, sent, flows } = setup();
    link.stage({ activityId: A, travelMode: "walk", encoderVersion: "e", gpx: GPX });
    sent.length = 0;
    flows.start();
    await settle();

    expect(await link.pendingActivities()).toEqual([]);
    expect(sent).toEqual([expect.objectContaining({ type: "activities" })]);
    expect(
      (sent[0] as Extract<NativeToWeb, { type: "activities" }>).items.map((i) => i.id),
    ).toEqual([A]);
  });

  it("hands off an activity as soon as it is staged, until stopped", async () => {
    const { link, activities, flows } = setup();
    const stop = flows.start();
    await settle();

    link.stage({ activityId: A, travelMode: "walk", encoderVersion: "e", gpx: GPX });
    await settle();
    expect(await activities.get(A)).not.toBeNull();

    stop();
    const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    link.stage({ activityId: B, travelMode: "walk", encoderVersion: "e", gpx: GPX });
    await settle();
    expect(await activities.get(B)).toBeNull();
  });

  it("publishes nothing when the hand-off stored nothing", async () => {
    const { sent, flows } = setup();
    flows.start();
    await settle();
    expect(sent).toEqual([]);
  });

  it("sends the history and the link status when the page is ready", async () => {
    const { sent, flows } = setup();
    await flows.ready();
    expect(sent.map((m) => m.type)).toEqual(["activities", "linkStatus"]);
  });

  it("routes the page's messages to the send and history flows", async () => {
    const { link, sent, flows } = setup();
    await flows.sendRoute(route());
    expect(link.queued()).toHaveLength(1);
    await flows.needTrack(A);
    await flows.deleteActivity(A);
    expect(sent.map((m) => m.type)).toEqual(["routeStatus", "activities"]);
  });

  it("hands off now and publishes once an activity was stored", async () => {
    const { link, activities, sent, flows } = setup();
    link.stage({ activityId: A, travelMode: "walk", encoderVersion: "e", gpx: GPX });
    sent.length = 0;

    await flows.handOffNow();

    expect(await activities.get(A)).not.toBeNull();
    expect(sent).toEqual([expect.objectContaining({ type: "activities" })]);
  });

  it("publishes nothing when a hand-off pass stores nothing", async () => {
    const { sent, flows } = setup();

    await flows.handOffNow();

    expect(sent).toEqual([]);
  });

  it("hands an export chunk to the export flow when there is one, and drops it otherwise", async () => {
    const chunk = { exportId: "e1", name: "abcd", index: 0, total: 1, files: 1, data: "" };
    const onChunk = vi.fn(async () => {});
    const withExport = createFlows({
      link: createFakeWatchLink(),
      activities: createMemoryActivityStore(),
      routes: createMemoryRouteStore(),
      send: () => {},
      exportFlow: { onChunk, clear: async () => {} },
      now: () => 0,
    });
    await withExport.exportBinary(chunk);
    expect(onChunk).toHaveBeenCalledExactlyOnceWith(chunk);
    await expect(setup().flows.exportBinary(chunk)).resolves.toBeUndefined();
  });

  it("does not lose an activity handed over between restore confirmation and swap", async () => {
    let confirmed!: () => void;
    const confirmation = new Promise<void>((resolve) => {
      confirmed = resolve;
    });
    const { link, activities, flows } = setupWithRestore(async (swap) => {
      await confirmation;
      link.stage({ activityId: A, travelMode: "walk", encoderVersion: "e", gpx: GPX });
      await flows.handOffNow();
      swap();
      return true;
    });
    flows.start();
    await settle();

    const restored = flows.restore();
    confirmed();
    expect(await restored).toBe(true);
    await settle();

    expect(await activities.get(A)).not.toBeNull();
    expect(await link.pendingActivities()).toEqual([]);
  });

  it("does not lose an activity whose commit was already running when the restore began", async () => {
    let commit!: () => void;
    const committing = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const link = createFakeWatchLink();
    const activities = swappableActivities();
    const slow: ActivityStore = {
      ...activities.store,
      add: async (a) => {
        await committing;
        return activities.store.add(a);
      },
    };
    const flows = createFlows({
      link,
      activities: slow,
      routes: createMemoryRouteStore(),
      send: () => {},
      backup: {
        backup: async () => {},
        restore: async () => {
          commit();
          await settle();
          activities.swap();
          return true;
        },
      },
      now: () => 0,
    });
    link.stage({ activityId: A, travelMode: "walk", encoderVersion: "e", gpx: GPX });
    const handOff = flows.handOffNow();
    await settle();

    expect(await flows.restore()).toBe(true);
    await handOff;
    await settle();

    expect(await activities.store.get(A)).not.toBeNull();
    expect(await link.pendingActivities()).toEqual([]);
  });

  it("runs a hand-off held by a restore once the restore ends, and publishes it", async () => {
    let finish!: (replaced: boolean) => void;
    const { link, activities, sent, flows } = setupWithRestore(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    flows.start();
    await settle();

    const restored = flows.restore();
    await settle();
    link.stage({ activityId: A, travelMode: "walk", encoderVersion: "e", gpx: GPX });
    await settle();
    expect(await activities.get(A)).toBeNull();
    expect(await link.pendingActivities()).toHaveLength(1);

    finish(false);
    expect(await restored).toBe(false);
    await settle();
    expect(await activities.get(A)).not.toBeNull();
    expect(await link.pendingActivities()).toEqual([]);
    expect(sent.map((m) => m.type)).toEqual(["activities"]);
  });
});
