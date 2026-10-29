import type { KeyState } from "../platform/watchLinkModule.js";

/** The state `keyPresence` reports: it reads no key, so it never says `unreadable`. */
export type KeyPresence = Exclude<KeyState, "unreadable">;

/**
 * Whether the device key may be replaced or dropped: its two halves cannot be used together, now
 * or on any later read. `existing` is not, since it may still read on a retry, and a database it
 * protects would become unreadable.
 */
export function keyIsLostOrUnreadable(state: KeyState): state is "lost" | "unreadable" {
  return state === "lost" || state === "unreadable";
}
