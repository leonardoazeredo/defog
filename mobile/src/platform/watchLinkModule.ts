import WatchLink, { type KeyState, type WatchLinkNativeEvents } from "../../modules/watch-link";

export type { KeyState, WatchLinkNativeEvents };

/** The native side found no usable database key although one was created before. */
export class KeyLostError extends Error {
  override name = "KeyLostError";
}

const KEY_STATES: readonly string[] = ["fresh", "existing", "lost", "unreadable"];

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
  return checkedKeyHex(hex);
}

function checkedKeyHex(hex: string): string {
  // The key is spliced into PRAGMA key with no bound parameter, so anything but 64 lowercase hex digits is refused rather than reaching SQL: a key read from native, and a generated one before native keeps it.
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("malformed database key");
  return hex;
}

/**
 * Keeps `keyHex` as the database key in place of a lost or unreadable one; the native side refuses
 * unless the key state reads `lost` or `unreadable`.
 */
export async function replaceLostDatabaseKeyHex(keyHex: string): Promise<void> {
  await WatchLink.replaceLostDatabaseKey(checkedKeyHex(keyHex));
}

/**
 * Drops a lost or unreadable database key so the next read mints a new one; the native side refuses
 * while the live database or a restore's replaced copy exists, or the key state reads `existing`.
 */
export async function resetKeys(): Promise<void> {
  await WatchLink.resetKeys();
}

/** The system save-as picker; null when the user backs out. */
export function createDocument(name: string, mime: string): Promise<string | null> {
  return WatchLink.createDocument(name, mime);
}

/** The name the provider gave a document, or null when it will not say. */
export function displayNameOf(uri: string): Promise<string | null> {
  return WatchLink.displayNameOf(uri);
}

/** Streams a cache file into a document; returns the bytes written. */
export function copyToUri(sourcePath: string, uri: string): Promise<number> {
  return WatchLink.copyToUri(sourcePath, uri);
}

/** Streams a document into a cache file; `head` is its first 16 bytes (fewer for a shorter file) as hex. */
export async function copyFromUri(
  uri: string,
  destPath: string,
): Promise<{ size: number; head: string }> {
  const r = await WatchLink.copyFromUri(uri, destPath);
  if (
    typeof r?.size !== "number" ||
    typeof r.head !== "string" ||
    !/^[0-9a-f]{0,32}$/.test(r.head)
  ) {
    throw new Error("watch link returned a malformed copy result");
  }
  return { size: r.size, head: r.head };
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
