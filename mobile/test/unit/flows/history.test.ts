import { describe, expect, it } from "vitest";
import { encode, type NativeToWeb, parseNativeToWeb } from "../../../src/bridge/protocol.js";
import { createHistoryFlow } from "../../../src/flows/history.js";
import {
  createMemoryActivityStore,
  createMemoryRouteStore,
} from "../../../src/history/memoryStores.js";
import type { Activity } from "../../../src/history/types.js";
import { activity, route } from "../history/fixtures.js";

const ID = (n: number) => `1111111${n}-1111-4111-8111-111111111111`;

function setup() {
  const activities = createMemoryActivityStore();
  const routes = createMemoryRouteStore();
  const sent: NativeToWeb[] = [];
  const flow = createHistoryFlow({ activities, routes, send: (m) => sent.push(m) });
  return { activities, routes, sent, flow };
}

function valid(sent: NativeToWeb[]): void {
  for (const m of sent) expect(parseNativeToWeb(encode(m))).toEqual(m);
}

function longTrack(n: number): Activity["track"] {
  return Array.from({ length: n }, (_, i) => ({ t: 1e12 + i * 3000, lat: 48.1, lon: 11.5 }));
}

describe("history", () => {
  it("publishes the summaries newest first, without the track or the file", async () => {
    const { activities, sent, flow } = setup();
    await activities.add(activity({ id: ID(1), startedAt: "2026-03-01T10:00:00Z" }));
    await activities.add(activity({ id: ID(2), startedAt: "2026-03-03T10:00:00Z" }));
    await activities.add(activity({ id: ID(3), startedAt: "2026-03-02T10:00:00Z" }));

    await flow.publish();

    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg).toMatchObject({ v: 1, type: "activities" });
    if (msg?.type !== "activities") throw new Error("expected activities");
    expect(msg.items.map((i) => i.id)).toEqual([ID(2), ID(3), ID(1)]);
    expect(msg.items[0]).not.toHaveProperty("track");
    expect(msg.items[0]).not.toHaveProperty("gpx");
    valid(sent);
  });

  it("publishes an empty list for an empty history", async () => {
    const { sent, flow } = setup();
    await flow.publish();
    expect(sent).toEqual([{ v: 1, type: "activities", items: [] }]);
  });

  it("sends 4500 points as three track messages, each with index below total", async () => {
    const { activities, sent, flow } = setup();
    await activities.add(activity({ id: ID(1), track: longTrack(4500) }));

    await flow.needTrack(ID(1));

    expect(
      sent.map((m) => (m.type === "track" ? [m.index, m.total, m.points.length] : null)),
    ).toEqual([
      [0, 3, 2000],
      [1, 3, 2000],
      [2, 3, 500],
    ]);
    for (const m of sent) expect(m).toMatchObject({ type: "track", activityId: ID(1) });
    valid(sent);
  });

  it("sends exactly 2000 points as one message and 2001 as two", async () => {
    const { activities, sent, flow } = setup();
    await activities.add(activity({ id: ID(1), track: longTrack(2000) }));
    await activities.add(activity({ id: ID(2), track: longTrack(2001) }));
    await flow.needTrack(ID(1));
    expect(sent).toHaveLength(1);
    sent.length = 0;
    await flow.needTrack(ID(2));
    expect(sent).toHaveLength(2);
  });

  it("sends one empty message for a track without points, so the page can finish", async () => {
    const { activities, sent, flow } = setup();
    await activities.add(activity({ id: ID(1), track: [] }));
    await flow.needTrack(ID(1));
    expect(sent).toEqual([
      { v: 1, type: "track", activityId: ID(1), index: 0, total: 1, points: [] },
    ]);
    valid(sent);
  });

  it("sends the followed route's geometry with the first chunk only", async () => {
    const { activities, routes, sent, flow } = setup();
    const followed = route({ id: ID(5) });
    await routes.save(followed);
    await activities.add(activity({ id: ID(1), routeId: ID(5), track: longTrack(2500) }));

    await flow.needTrack(ID(1));

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ index: 0, route: { coords: followed.coords } });
    expect(sent[1]).not.toHaveProperty("route");
    valid(sent);
  });

  it("sends no route for an activity that followed none", async () => {
    const { activities, sent, flow } = setup();
    await activities.add(activity({ id: ID(1) }));
    await flow.needTrack(ID(1));
    expect(sent[0]).not.toHaveProperty("route");
  });

  it("sends the track alone when the followed route is not stored", async () => {
    const { activities, sent, flow } = setup();
    await activities.add(activity({ id: ID(1), routeId: ID(5) }));
    await flow.needTrack(ID(1));
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("route");
    valid(sent);
  });

  it("sends the track alone when reading the followed route fails", async () => {
    const { activities, routes, sent } = setup();
    const flow = createHistoryFlow({
      activities,
      routes: {
        get: async () => {
          throw new Error("database is locked");
        },
      },
      send: (m) => sent.push(m),
    });
    await routes.save(route({ id: ID(5) }));
    await activities.add(activity({ id: ID(1), routeId: ID(5) }));

    await flow.needTrack(ID(1));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "track", index: 0 });
    expect(sent[0]).not.toHaveProperty("route");
  });

  it("sends nothing for an activity it does not have", async () => {
    const { sent, flow } = setup();
    await flow.needTrack(ID(9));
    expect(sent).toEqual([]);
  });

  it("deletes the activity and publishes the rest", async () => {
    const { activities, sent, flow } = setup();
    await activities.add(activity({ id: ID(1) }));
    await activities.add(activity({ id: ID(2), startedAt: "2026-03-02T10:00:00Z" }));

    await flow.deleteActivity(ID(2));

    expect(await activities.get(ID(2))).toBeNull();
    expect(sent).toHaveLength(1);
    expect(
      (sent[0] as Extract<NativeToWeb, { type: "activities" }>).items.map((i) => i.id),
    ).toEqual([ID(1)]);
    valid(sent);
  });

  it("publishes again after deleting an id that is already gone", async () => {
    const { sent, flow } = setup();
    await flow.deleteActivity(ID(9));
    expect(sent).toEqual([{ v: 1, type: "activities", items: [] }]);
  });

  it("tells the page when the store fails, and does not reject", async () => {
    const { activities, sent } = setup();
    const flow = createHistoryFlow({
      routes: createMemoryRouteStore(),
      activities: {
        ...activities,
        delete: async () => {
          throw new Error("database is locked");
        },
        list: async () => {
          throw new Error("database is locked");
        },
        get: async () => {
          throw new Error("database is locked");
        },
      },
      send: (m) => sent.push(m),
    });
    await expect(flow.deleteActivity(ID(1))).resolves.toBeUndefined();
    await expect(flow.needTrack(ID(1))).resolves.toBeUndefined();
    await expect(flow.publish()).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "notice" });
    valid(sent);
  });
});
