import { parseGpx } from "../history/gpx.js";
import type { ActivityOffer } from "../link/types.js";

export interface AddActivityDeps {
  /** The text of the GPX file the user picked, or null when they cancelled. */
  pick(): Promise<string | null>;
  stage(offer: ActivityOffer): Promise<void>;
  handOff: { run(): Promise<unknown> };
  newId(): string;
}

// Goes through the staging store and the hand-off flow rather than the activity store, so the
// emulator exercises the same path a watch offer takes.
export async function addActivityFromGpx(deps: AddActivityDeps): Promise<void> {
  const gpx = await deps.pick();
  if (gpx === null) return;
  // An offer the hand-off cannot parse would stay staged for good.
  parseGpx(gpx);
  await deps.stage({ activityId: deps.newId(), travelMode: "walk", encoderVersion: "dev", gpx });
  await deps.handOff.run();
}
