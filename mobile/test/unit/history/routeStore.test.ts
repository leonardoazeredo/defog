import { describe, expect, it } from "vitest";
import { migrate } from "../../../src/db/schema.js";
import { createMemoryRouteStore } from "../../../src/history/memoryStores.js";
import { createRouteStore } from "../../../src/history/routeStore.js";
import type { RouteStore } from "../../../src/history/types.js";
import { createNodeSqliteDriver } from "../../support/nodeSqliteDriver.js";
import { route } from "./fixtures.js";

const NOW = "2026-03-02T12:00:00.000Z";
const impls: [string, () => Promise<RouteStore>][] = [
  [
    "sqlite",
    async () => {
      const db = createNodeSqliteDriver(":memory:");
      await migrate(db);
      return createRouteStore(db, { now: () => new Date(NOW) });
    },
  ],
  ["memory", async () => createMemoryRouteStore({ now: () => new Date(NOW) })],
];

describe.each(impls)("route store (%s)", (_name, make) => {
  it("saves a route and gives it back whole, nulls and optional fields included", async () => {
    const s = await make();
    await s.save(route());
    expect(await s.get(route().id)).toEqual(route());
    await s.save(
      route({
        id: "44444444-4444-4444-8444-444444444444",
        targetDistanceM: undefined,
        mode: "p2p",
      }),
    );
    expect((await s.get("44444444-4444-4444-8444-444444444444"))?.targetDistanceM).toBeUndefined();
  });

  it("returns null for an unknown id", async () => {
    expect(await (await make()).get("33333333-3333-4333-8333-333333333333")).toBeNull();
  });

  it("lists newest first without geometry or file", async () => {
    const s = await make();
    await s.save(
      route({ id: "44444444-4444-4444-8444-444444444441", createdAt: "2026-01-01T00:00:00Z" }),
    );
    await s.save(
      route({ id: "44444444-4444-4444-8444-444444444442", createdAt: "2026-02-01T00:00:00Z" }),
    );
    const list = await s.list();
    expect(list.map((r) => r.id.slice(-1))).toEqual(["2", "1"]);
    expect(list[0]).not.toHaveProperty("coords");
    expect(list[0]).not.toHaveProperty("gpx");
    expect(list[0]).not.toHaveProperty("waypoints");
    expect(list[0]?.stats.seconds).toBeNull();
  });

  it("marks a route sent", async () => {
    const s = await make();
    await s.save(route());
    expect((await s.get(route().id))?.sentAt).toBeUndefined();
    await s.markSent(route().id);
    expect((await s.get(route().id))?.sentAt).toBe(NOW);
    expect((await s.list())[0]?.sentAt).toBe(NOW);
  });

  it("refuses to mark an unknown route sent", async () => {
    await expect((await make()).markSent(route().id)).rejects.toThrow(/unknown route/);
  });

  it("clears sentAt when the route is saved again", async () => {
    const s = await make();
    await s.save(route());
    await s.markSent(route().id);
    await s.save(route({ gpx: "edited" }));
    const got = await s.get(route().id);
    expect(got?.sentAt).toBeUndefined();
    expect(got?.gpx).toBe("edited");
  });
});
