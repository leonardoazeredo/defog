import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addActivityFromGpx } from "../../../src/dev/addActivity.js";
import { createHandOffFlow } from "../../../src/flows/handOff.js";
import { GpxError, parseGpx } from "../../../src/history/gpx.js";
import { createMemoryActivityStore } from "../../../src/history/memoryStores.js";
import { createFakeWatchLink } from "../../../src/link/fakeWatchLink.js";

const WALK = readFileSync(new URL("../../fixtures/glancemap-walk.gpx", import.meta.url), "utf-8");
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function setup(picked: string | null) {
  const link = createFakeWatchLink();
  const activities = createMemoryActivityStore();
  const handOff = createHandOffFlow({ link, activities, parseGpx, now: () => 0 });
  const deps = {
    pick: async () => picked,
    stage: async (offer: Parameters<typeof link.stage>[0]) => link.stage(offer),
    handOff,
    newId: () => ID,
  };
  return { link, activities, deps };
}

describe("developer add activity", () => {
  it("stages the picked walk, hands it off and releases the staged copy", async () => {
    const { link, activities, deps } = setup(WALK);

    await addActivityFromGpx(deps);

    const stored = await activities.get(ID);
    expect(stored).toMatchObject({ id: ID, travelMode: "walk", encoderVersion: "dev", gpx: WALK });
    expect(stored?.track.length).toBeGreaterThan(1);
    expect(await activities.list()).toHaveLength(1);
    expect(await link.pendingActivities()).toEqual([]);
    expect(link.released()).toEqual([ID]);
  });

  it("adds nothing when the picker is cancelled", async () => {
    const { link, activities, deps } = setup(null);

    await addActivityFromGpx(deps);

    expect(await activities.list()).toEqual([]);
    expect(await link.pendingActivities()).toEqual([]);
    expect(link.released()).toEqual([]);
  });

  it("rejects a file that is not a GPX track without staging it", async () => {
    const { link, activities, deps } = setup("not gpx at all");

    await expect(addActivityFromGpx(deps)).rejects.toBeInstanceOf(GpxError);

    expect(await activities.list()).toEqual([]);
    expect(await link.pendingActivities()).toEqual([]);
  });
});
