export type KeyState = "fresh" | "existing" | "lost";

export type WatchLinkNativeEvents = {
  activityStaged(event: { activityId: string }): void;
  linkStatus(event: { paired: boolean; reachable: boolean }): void;
  routeSaved(event: { routeId: string }): void;
};
