import * as Crypto from "expo-crypto";
import { toHex } from "../bridge/hex.js";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // The bytes come from File.bytes(), never a SharedArrayBuffer, but the digest's BufferSource type only admits ArrayBuffer.
  const buffer = bytes as Uint8Array<ArrayBuffer>;
  return toHex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, buffer));
}
