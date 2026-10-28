import { describe, expect, it } from "vitest";
import { migrate } from "../../../src/db/schema.js";
import { createActivityStore } from "../../../src/history/activityStore.js";
import { createMemoryActivityStore } from "../../../src/history/memoryStores.js";
import type { ActivityStore } from "../../../src/history/types.js";
import { createNodeSqliteDriver } from "../../support/nodeSqliteDriver.js";
import { activity } from "./fixtures.js";

const impls: [string, () => Promise<ActivityStore>][] = [
  [
    "sqlite",
    async () => {
      const db = createNodeSqliteDriver(":memory:");
      await migrate(db);
      return createActivityStore(db);
    },
  ],
  ["memory", async () => createMemoryActivityStore()],
];

describe.each(impls)("activity store (%s)", (_name, make) => {
  it("stores a new activity", async () => {
    const s = await make();
    expect(await s.add(activity())).toEqual({ stored: true });
  });

  it("leaves the first record alone when the same id comes again", async () => {
    const s = await make();
    await s.add(activity({ gpx: "first" }));
    expect(await s.add(activity({ gpx: "second" }))).toEqual({ stored: false });
    expect((await s.get(activity().id))?.gpx).toBe("first");
    expect(await s.list()).toHaveLength(1);
  });

  it("lists newest start first with the summary fields only", async () => {
    const s = await make();
    await s.add(
      activity({ id: "a0000000-0000-4000-8000-000000000001", startedAt: "2026-01-01T08:00:00Z" }),
    );
    await s.add(
      activity({
        id: "a0000000-0000-4000-8000-000000000002",
        startedAt: "2026-02-01T08:00:00Z",
        routeId: "22222222-2222-4222-8222-222222222222",
      }),
    );
    await s.add(
      activity({ id: "a0000000-0000-4000-8000-000000000003", startedAt: "2026-02-01T08:00:00.5Z" }),
    );
    const list = await s.list();
    expect(list.map((a) => a.id.slice(-1))).toEqual(["3", "2", "1"]);
    expect(list[1]?.routeId).toBe("22222222-2222-4222-8222-222222222222");
    expect(list[0]).not.toHaveProperty("gpx");
    expect(list[0]).not.toHaveProperty("track");
    expect(list[0]).not.toHaveProperty("receivedAt");
    expect(list[0]).not.toHaveProperty("routeId");
  });

  it("gives back the full record with its track", async () => {
    const s = await make();
    const a = activity({ routeId: "22222222-2222-4222-8222-222222222222" });
    await s.add(a);
    expect(await s.get(a.id)).toEqual(a);
  });

  it("returns null for an unknown id", async () => {
    expect(await (await make()).get("33333333-3333-4333-8333-333333333333")).toBeNull();
  });

  it("deletes once, then reports nothing to delete", async () => {
    const s = await make();
    await s.add(activity());
    expect(await s.delete(activity().id)).toBe(true);
    expect(await s.delete(activity().id)).toBe(false);
    expect(await s.get(activity().id)).toBeNull();
  });

  it("does not share state with the record that was added", async () => {
    const s = await make();
    const a = activity();
    await s.add(a);
    a.track.push({ t: 9, lat: 0, lon: 0 });
    expect((await s.get(a.id))?.track).toHaveLength(2);
  });
});

describe("activity store (sqlite) at rest", () => {
  it("keeps the GPX deflated, not as text", async () => {
    const db = createNodeSqliteDriver(":memory:");
    await migrate(db);
    const gpx = `<gpx>${'<trkpt lat="48.1" lon="11.5"/>'.repeat(100)}</gpx>`;
    await createActivityStore(db).add(activity({ gpx }));
    const [row] = await db.all<{ gpx_deflated: Uint8Array }>("SELECT gpx_deflated FROM activities");
    expect(row?.gpx_deflated).toBeInstanceOf(Uint8Array);
    expect(row?.gpx_deflated.length).toBeLessThan(gpx.length / 4);
    expect(new TextDecoder().decode(row?.gpx_deflated)).not.toContain("<gpx>");
    expect((await createActivityStore(db).get(activity().id))?.gpx).toBe(gpx);
  });
});
