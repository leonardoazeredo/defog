import { NativeModule, requireNativeModule } from "expo";
import type { KeyState } from "./WatchLink.types";

declare class WatchLinkModule extends NativeModule<Record<string, never>> {
  getDatabaseKeyHex(): Promise<string>;
  keyState(): Promise<KeyState>;
}

export default requireNativeModule<WatchLinkModule>("WatchLink");
