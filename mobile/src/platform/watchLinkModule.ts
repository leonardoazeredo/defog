import WatchLink, { type KeyState, type WatchLinkNativeEvents } from "../../modules/watch-link";

export type { KeyState, WatchLinkNativeEvents };

/** The native side found no usable database key although one was created before. */
export class KeyLostError extends Error {
  override name = "KeyLostError";
}

const KEY_STATES: readonly string[] = ["fresh", "existing", "lost"];

export async function getDatabaseKeyHex(): Promise<string> {
  let hex: string;
  try {
    hex = await WatchLink.getDatabaseKeyHex();
  } catch (e) {
    if (e instanceof Error && (e as { code?: unknown }).code === "ERR_KEY_LOST") {
      throw new KeyLostError("database key is lost", { cause: e });
    }
    throw e;
  }
  // The value goes straight into PRAGMA key; anything but 32 bytes of hex would key the database wrongly.
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("watch link returned a malformed database key");
  return hex;
}

export async function keyState(): Promise<KeyState> {
  const state = await WatchLink.keyState();
  if (!KEY_STATES.includes(state)) throw new Error("watch link returned an unknown key state");
  return state;
}

// What follows returns native values unchecked: src/link/watchLink.ts validates them.

export function linkStatus(): Promise<unknown> {
  return WatchLink.status();
}

export function pendingActivities(): Promise<unknown> {
  return WatchLink.pendingActivities();
}

export function readActivity(id: string): Promise<string> {
  return WatchLink.readActivity(id);
}

export function releaseActivity(id: string): Promise<void> {
  return WatchLink.release(id);
}

export function queueRoute(routeJson: string): Promise<void> {
  return WatchLink.queueRoute(routeJson);
}

/** Returns the function that removes the listener. */
export function onLinkEvent(
  event: keyof WatchLinkNativeEvents,
  fn: (payload: unknown) => void,
): () => void {
  const subscription = WatchLink.addListener(event, fn);
  return () => subscription.remove();
}
