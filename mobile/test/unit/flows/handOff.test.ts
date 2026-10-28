import { describe, expect, it, vi } from "vitest";
import { createHandOffFlow } from "../../../src/flows/handOff.js";
import { parseGpx } from "../../../src/history/gpx.js";
import { createMemoryActivityStore } from "../../../src/history/memoryStores.js";
import { createFakeWatchLink } from "../../../src/link/fakeWatchLink.js";
import type { ActivityOffer } from "../../../src/link/types.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROUTE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = Date.parse("2026-03-02T08:00:00Z");

// Two points 3 s apart, about 13 m; the start decides the activity's place in the history.
function gpx(start: string): string {
  const t = Date.parse(start);
  const at = (ms: number) => new Date(t + ms).toISOString();
  return (
    `<gpx><metadata><extensions><gmap:stepCount>9</gmap:stepCount></extensions></metadata><trk><trkseg>` +
    `<trkpt lat="51.4769" lon="0.0005"><time>${at(0)}</time></trkpt>` +
    `<trkpt lat="51.4770" lon="0.0006"><time>${at(3000)}</time></trkpt>` +
    `</trkseg></trk></gpx>`
  );
}

function offer(id: string, start: string, over: Partial<ActivityOffer> = {}): ActivityOffer {
  return { activityId: id, travelMode: "walk", encoderVersion: "enc-1", gpx: gpx(start), ...over };
}

function setup() {
  const link = createFakeWatchLink();
  const activities = createMemoryActivityStore();
  const flow = createHandOffFlow({ link, activities, parseGpx, now: () => NOW });
  return { link, activities, flow };
}

describe("hand-off", () => {
  it("stores a staged offer, then releases it", async () => {
    const { link, activities, flow } = setup();
    link.stage(offer(A, "2026-03-01T10:00:00Z", { routeId: ROUTE }));

    expect(await flow.run()).toEqual({ stored: 1, released: 1, unreadable: 0 });

    const stored = await activities.get(A);
    expect(stored).toMatchObject({
      id: A,
      travelMode: "walk",
      routeId: ROUTE,
      startedAt: "2026-03-01T10:00:00.000Z",
      endedAt: "2026-03-01T10:00:03.000Z",
      receivedAt: "2026-03-02T08:00:00.000Z",
      encoderVersion: "enc-1",
      stats: { durationS: 3, steps: 9 },
    });
    expect(await activities.gpx(A)).toBe(gpx("2026-03-01T10:00:00Z"));
    expect(stored?.track).toHaveLength(2);
    expect(await link.pendingActivities()).toEqual([]);
    expect(link.released()).toEqual([A]);
  });

  it("does nothing when nothing is staged", async () => {
    const { flow, link } = setup();
    expect(await flow.run()).toEqual({ stored: 0, released: 0, unreadable: 0 });
    expect(link.released()).toEqual([]);
  });

  it("repeats the release after a crash between the commit and the release, and stores nothing twice", async () => {
    const { link, activities } = setup();
    let crash = true;
    const crashing = {
      ...link,
      release: async (id: string) => {
        if (crash) {
          crash = false;
          throw new Error("process died");
        }
        await link.release(id);
      },
    };
    const flow = createHandOffFlow({
      link: crashing,
      activities,
      parseGpx,
      now: () => NOW,
    });
    link.stage(offer(A, "2026-03-01T10:00:00Z"));

    expect(await flow.run()).toEqual({ stored: 1, released: 0, unreadable: 0 });
    expect(await link.pendingActivities()).toHaveLength(1);

    expect(await flow.run()).toEqual({ stored: 0, released: 1, unreadable: 0 });
    expect(await link.pendingActivities()).toEqual([]);
    expect(await activities.list()).toHaveLength(1);
  });

  it("leaves the offer staged when the commit fails, and stores it on the next run", async () => {
    const { link, activities } = setup();
    let fail = true;
    const flaky = {
      add: async (a: Parameters<typeof activities.add>[0]) => {
        if (fail) {
          fail = false;
          throw new Error("disk full");
        }
        return activities.add(a);
      },
    };
    const flow = createHandOffFlow({ link, activities: flaky, parseGpx, now: () => NOW });
    link.stage(offer(A, "2026-03-01T10:00:00Z"));

    expect(await flow.run()).toEqual({ stored: 0, released: 0, unreadable: 0 });
    expect(link.released()).toEqual([]);
    expect(await link.pendingActivities()).toHaveLength(1);

    expect(await flow.run()).toEqual({ stored: 1, released: 1, unreadable: 0 });
  });

  it("stores one activity when the same offer is staged twice", async () => {
    const { link, activities, flow } = setup();
    link.stage(offer(A, "2026-03-01T10:00:00Z"));
    link.stage(offer(A, "2026-03-01T10:00:00Z"));

    expect(await flow.run()).toEqual({ stored: 1, released: 1, unreadable: 0 });
    link.stage(offer(A, "2026-03-01T10:00:00Z"));
    expect(await flow.run()).toEqual({ stored: 0, released: 1, unreadable: 0 });
    expect(await activities.list()).toHaveLength(1);
  });

  it("stores two offers staged out of order and lists them by start time", async () => {
    const { link, activities, flow } = setup();
    link.stage(offer(B, "2026-03-01T12:00:00Z"));
    link.stage(offer(A, "2026-03-01T10:00:00Z"));

    expect(await flow.run()).toEqual({ stored: 2, released: 2, unreadable: 0 });
    expect((await activities.list()).map((a) => a.id)).toEqual([B, A]);
  });

  it("leaves an unparsable offer staged and still handles the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { link, activities, flow } = setup();
    link.stage(offer(A, "2026-03-01T10:00:00Z", { gpx: "<gpx></gpx>" }));
    link.stage(offer(B, "2026-03-01T12:00:00Z"));

    expect(await flow.run()).toEqual({ stored: 1, released: 1, unreadable: 1 });
    expect((await link.pendingActivities()).map((p) => p.activityId)).toEqual([A]);
    expect((await activities.list()).map((a) => a.id)).toEqual([B]);
    expect(link.released()).toEqual([B]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(A);
    warn.mockRestore();
  });

  it("skips an offer that disappears between the list and the read", async () => {
    const { link, activities } = setup();
    link.stage(offer(A, "2026-03-01T10:00:00Z"));
    link.stage(offer(B, "2026-03-01T12:00:00Z"));
    const vanishing = {
      ...link,
      readActivity: async (id: string) => {
        if (id === A) throw new Error("activity is not staged");
        return link.readActivity(id);
      },
    };
    const flow = createHandOffFlow({ link: vanishing, activities, parseGpx, now: () => NOW });

    expect(await flow.run()).toEqual({ stored: 1, released: 1, unreadable: 0 });
  });

  it("leaves an offer staged when it names a different id than the staged one", async () => {
    const { link, activities } = setup();
    link.stage(offer(A, "2026-03-01T10:00:00Z"));
    const mismatched = { ...link, readActivity: async () => offer(B, "2026-03-01T10:00:00Z") };
    const flow = createHandOffFlow({ link: mismatched, activities, parseGpx, now: () => NOW });

    expect(await flow.run()).toEqual({ stored: 0, released: 0, unreadable: 1 });
    expect(await activities.list()).toEqual([]);
    expect(link.released()).toEqual([]);
  });

  it("counts the staged items the phone cannot read, leaves them staged and handles the others", async () => {
    const { link, activities, flow } = setup();
    link.stageUnreadable(A);
    link.stage(offer(B, "2026-03-01T12:00:00Z"));

    expect(await flow.run()).toEqual({ stored: 1, released: 1, unreadable: 1 });
    expect((await activities.list()).map((a) => a.id)).toEqual([B]);
    expect(link.released()).toEqual([B]);
    expect(await flow.run()).toEqual({ stored: 0, released: 0, unreadable: 1 });
  });

  it("gives no count when the phone cannot say how many items it cannot read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { link, activities } = setup();
    link.stage(offer(A, "2026-03-01T10:00:00Z"));
    const broken = {
      ...link,
      unreadableActivities: async () => {
        throw new Error("module unavailable");
      },
    };
    const flow = createHandOffFlow({ link: broken, activities, parseGpx, now: () => NOW });
    expect(await flow.run()).toEqual({ stored: 1, released: 1, unreadable: null });
    warn.mockRestore();
  });

  it("does not reject when the list of staged offers cannot be read", async () => {
    const { link, activities } = setup();
    const broken = {
      ...link,
      pendingActivities: async () => {
        throw new Error("module unavailable");
      },
    };
    const flow = createHandOffFlow({ link: broken, activities, parseGpx, now: () => NOW });
    expect(await flow.run()).toEqual({ stored: 0, released: 0, unreadable: null });
  });

  it("never runs two passes at once, and an offer staged mid-pass is picked up after it", async () => {
    const { link, activities } = setup();
    let open = 0;
    let overlap = false;
    let gate!: () => void;
    const held = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const slow = {
      ...link,
      readActivity: async (id: string) => {
        open++;
        if (open > 1) overlap = true;
        if (id === A) await held;
        const read = await link.readActivity(id);
        open--;
        return read;
      },
    };
    const flow = createHandOffFlow({ link: slow, activities, parseGpx, now: () => NOW });
    link.stage(offer(A, "2026-03-01T10:00:00Z"));

    const first = flow.run();
    await Promise.resolve();
    link.stage(offer(B, "2026-03-01T12:00:00Z"));
    const second = flow.run();
    const third = flow.run();
    gate();

    expect(await first).toEqual({ stored: 1, released: 1, unreadable: 0 });
    expect(await second).toEqual({ stored: 1, released: 1, unreadable: 0 });
    expect(await third).toEqual(await second);
    expect(overlap).toBe(false);
    expect((await activities.list()).map((a) => a.id)).toEqual([B, A]);
  });

  it("keeps the staged copy of an activity that commits while a restore holds the hand-off", async () => {
    const { link, activities } = setup();
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const slow = {
      add: async (a: Parameters<typeof activities.add>[0]) => {
        await committed;
        return activities.add(a);
      },
    };
    const flow = createHandOffFlow({ link, activities: slow, parseGpx, now: () => NOW });
    link.stage(offer(A, "2026-03-01T10:00:00Z"));

    const pass = flow.run();
    await new Promise((r) => setTimeout(r, 0));
    const restore = flow.hold(async () => {
      commit();
      return await pass;
    });

    expect(await restore).toEqual({ stored: 1, released: 0, unreadable: 0 });
    expect(link.released()).toEqual([]);
    expect((await link.pendingActivities()).map((p) => p.activityId)).toEqual([A]);
  });

  it("starts no offer while held, and takes it on the first run after the hold", async () => {
    const { link, activities, flow } = setup();
    link.stage(offer(A, "2026-03-01T10:00:00Z"));

    expect(await flow.hold(() => flow.run())).toEqual({
      stored: 0,
      released: 0,
      unreadable: null,
    });
    expect(await activities.list()).toEqual([]);
    expect(await link.pendingActivities()).toHaveLength(1);

    expect(await flow.run()).toEqual({ stored: 1, released: 1, unreadable: 0 });
    expect(link.released()).toEqual([A]);
  });

  it("returns what the held work returns, and ends the hold when that work fails", async () => {
    const { link, flow } = setup();
    await expect(flow.hold(async () => "done")).resolves.toBe("done");
    await expect(
      flow.hold(async () => {
        throw new Error("restore failed");
      }),
    ).rejects.toThrow("restore failed");

    link.stage(offer(A, "2026-03-01T10:00:00Z"));
    expect(await flow.run()).toEqual({ stored: 1, released: 1, unreadable: 0 });
  });
});
