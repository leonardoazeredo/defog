import { toHex } from "../bridge/hex.js";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return toHex(new Uint8Array(buf));
}
