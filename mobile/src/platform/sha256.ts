import { sha256 } from "@noble/hashes/sha2.js";
import { toHex } from "../bridge/hex.js";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(sha256(bytes));
}
