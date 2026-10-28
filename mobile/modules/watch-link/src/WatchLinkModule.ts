import { NativeModule, requireNativeModule } from "expo";
import type { KeyState, WatchLinkNativeEvents } from "./WatchLink.types";

declare class WatchLinkModule extends NativeModule<WatchLinkNativeEvents> {
  getDatabaseKeyHex(): Promise<string>;
  keyState(): Promise<KeyState>;
  replaceLostDatabaseKey(keyHex: string): Promise<void>;
  resetKeys(): Promise<void>;
  createDocument(name: string, mime: string): Promise<string | null>;
  displayNameOf(uri: string): Promise<string | null>;
  copyToUri(sourcePath: string, uri: string): Promise<number>;
  copyFromUri(uri: string, destPath: string): Promise<{ size: number; head: string }>;
  status(): Promise<unknown>;
  pendingActivities(): Promise<unknown>;
  unreadableActivities(): Promise<unknown>;
  readActivity(id: string): Promise<string>;
  release(id: string): Promise<void>;
  queueRoute(routeJson: string): Promise<void>;
  /** Debug builds only; undefined in release. */
  stageForTest?(offerJson: string): Promise<void>;
}

export default requireNativeModule<WatchLinkModule>("WatchLink");
