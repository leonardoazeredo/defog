import { describe, expect, it } from "vitest";
import type { NativeToWeb } from "../../../src/bridge/protocol.js";
import { createFlows } from "../../../src/flows/compose.js";
import {
  createMemoryActivityStore,
  createMemoryRouteStore,
} from "../../../src/history/memoryStores.js";
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
});
