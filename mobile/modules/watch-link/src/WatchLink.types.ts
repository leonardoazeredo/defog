// "existing": the key file and the Keystore key are both present and the key did not fail for good
// (it may still fail on a read); "unreadable": both are present but unwrapping fails for good.
export type KeyState = "fresh" | "existing" | "lost" | "unreadable";

export type WatchLinkNativeEvents = {
  activityStaged(event: { activityId: string }): void;
  linkStatus(event: { paired: boolean; reachable: boolean }): void;
  routeSaved(event: { routeId: string }): void;
};
