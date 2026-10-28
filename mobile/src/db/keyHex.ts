import { toHex } from "../bridge/hex.js";

declare const brand: unique symbol;

/** A compile-time brand only: a cast gets past it, so the module and the driver check again. */
export type DatabaseKeyHex = string & { readonly [brand]: "DatabaseKeyHex" };

const KEY_BYTES = 32;

/**
 * The key is spliced into PRAGMA key with no bound parameter, so anything but 64 lowercase hex
 * digits is refused rather than reaching SQL.
 */
export function checkedKeyHex(hex: string): DatabaseKeyHex {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("malformed database key");
  return hex as DatabaseKeyHex;
}

/** A new random database key; the random bytes are wiped once they are hex. */
export function newDatabaseKeyHex(randomBytes: (n: number) => Uint8Array): DatabaseKeyHex {
  const bytes = randomBytes(KEY_BYTES);
  try {
    return checkedKeyHex(toHex(bytes));
  } finally {
    bytes.fill(0);
  }
}
