import { describe, expect, it, vi } from "vitest";
import { createFakeWatchLink } from "../../../src/link/fakeWatchLink";
import type { ActivityOffer } from "../../../src/link/types";
import { route as routeRecord } from "../history/fixtures";

const offer = (n: number, extra: Partial<ActivityOffer> = {}): ActivityOffer => ({
  activityId: `0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a000${n}`,
  travelMode: "walk",
  encoderVersion: "1",
  gpx: `<gpx>${n}</gpx>`,
  ...extra,
});

describe("fake watch link", () => {
  it("lists a staged activity without its file and emits activityStaged", async () => {
    const link = createFakeWatchLink();
    const seen = vi.fn();
    link.on("activityStaged", seen);
    link.stage(offer(1));
    expect(seen).toHaveBeenCalledExactlyOnceWith({ activityId: offer(1).activityId });
    expect(await link.pendingActivities()).toEqual([
      { activityId: offer(1).activityId, travelMode: "walk", encoderVersion: "1" },
    ]);
  });

  it("returns the whole offer from readActivity and rejects an unknown id", async () => {
    const link = createFakeWatchLink();
    link.stage(offer(1, { routeId: "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0009" }));
    await expect(link.readActivity(offer(1).activityId)).resolves.toEqual(
      offer(1, { routeId: "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0009" }),
    );
    await expect(link.readActivity(offer(2).activityId)).rejects.toThrow("not staged");
  });

  it("keeps one item per id, with the last offer", async () => {
    const link = createFakeWatchLink();
    link.stage(offer(1));
    link.stage(offer(1, { gpx: "<gpx>later</gpx>" }));
    expect(await link.pendingActivities()).toHaveLength(1);
    expect((await link.readActivity(offer(1).activityId)).gpx).toBe("<gpx>later</gpx>");
  });

  it("release removes the item and records the id; an unknown id is harmless", async () => {
    const link = createFakeWatchLink();
    link.stage(offer(1));
    await link.release(offer(1).activityId);
    await link.release(offer(2).activityId);
    expect(await link.pendingActivities()).toEqual([]);
    expect(link.released()).toEqual([offer(1).activityId, offer(2).activityId]);
  });

  it("release refuses an id that is not a UUID, as the native side does", async () => {
    const link = createFakeWatchLink();
    link.stage(offer(1));
    await expect(link.release("../x")).rejects.toThrow("invalid id");
    expect(link.released()).toEqual([]);
    expect(await link.pendingActivities()).toHaveLength(1);
  });

  it("queueRoute records the route, and a second queue of the same id replaces it", async () => {
    const link = createFakeWatchLink();
    const route = routeRecord();
    await link.queueRoute(route);
    await link.queueRoute({ ...route, gpx: "<gpx>edited</gpx>" });
    expect(link.queued()).toEqual([{ ...route, gpx: "<gpx>edited</gpx>" }]);
  });

  it("confirmRoute emits routeSaved for a queued route and refuses an unknown one", async () => {
    const link = createFakeWatchLink();
    const seen = vi.fn();
    link.on("routeSaved", seen);
    const route = routeRecord();
    await link.queueRoute(route);
    link.confirmRoute(route.id);
    expect(seen).toHaveBeenCalledExactlyOnceWith({ routeId: route.id });
    expect(() => link.confirmRoute("0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a00ff")).toThrow("not queued");
  });

  it("starts unpaired and unreachable; setStatus changes it and emits linkStatus", async () => {
    const link = createFakeWatchLink();
    const seen = vi.fn();
    link.on("linkStatus", seen);
    expect(await link.status()).toEqual({ paired: false, reachable: false });
    link.setStatus({ paired: true, reachable: true });
    expect(await link.status()).toEqual({ paired: true, reachable: true });
    expect(seen).toHaveBeenCalledExactlyOnceWith({ paired: true, reachable: true });
  });

  it("pair marks the link paired but not reachable", async () => {
    const link = createFakeWatchLink();
    await link.pair("qr");
    expect(await link.status()).toEqual({ paired: true, reachable: false });
  });

  it("the function on returns stops the listener, and other listeners keep hearing", () => {
    const link = createFakeWatchLink();
    const gone = vi.fn();
    const kept = vi.fn();
    const off = link.on("activityStaged", gone);
    link.on("activityStaged", kept);
    off();
    off();
    link.stage(offer(1));
    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledOnce();
  });

  it("does not hand out its own state: later edits to a returned value change nothing", async () => {
    const link = createFakeWatchLink();
    link.stage(offer(1));
    const [first] = await link.pendingActivities();
    Object.assign(first ?? {}, { travelMode: "run" });
    expect(await link.pendingActivities()).toEqual([
      { activityId: offer(1).activityId, travelMode: "walk", encoderVersion: "1" },
    ]);
  });
});

describe("fake watch link routes", () => {
  it("keeps the queued route as it was handed over, whatever the caller does after", async () => {
    const link = createFakeWatchLink();
    const r = routeRecord();
    await link.queueRoute(r);
    r.coords.length = 0;
    link.queued()[0]?.waypoints.pop();
    expect(link.queued()[0]?.coords).toHaveLength(2);
    expect(link.queued()[0]?.waypoints).toHaveLength(2);
  });
});
