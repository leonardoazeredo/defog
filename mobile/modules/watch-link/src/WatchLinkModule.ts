import { NativeModule, requireNativeModule } from "expo";
import type { KeyState, WatchLinkNativeEvents } from "./WatchLink.types";

declare class WatchLinkModule extends NativeModule<WatchLinkNativeEvents> {
  getDatabaseKeyHex(): Promise<string>;
  keyState(): Promise<KeyState>;
  status(): Promise<unknown>;
  pendingActivities(): Promise<unknown>;
  readActivity(id: string): Promise<string>;
  release(id: string): Promise<void>;
  queueRoute(routeJson: string): Promise<void>;
  /** Debug builds only; undefined in release. */
  stageForTest?(offerJson: string): Promise<void>;
}

export default requireNativeModule<WatchLinkModule>("WatchLink");
