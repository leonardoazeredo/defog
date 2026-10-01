// @noble/hashes is an optional build-time dep for platforms without crypto.subtle.
// Declare its shape so tsc is satisfied even when it isn't installed.
declare module "@noble/hashes/sha256" {
  export function sha256(data: Uint8Array): Uint8Array;
}
declare module "@noble/hashes/utils" {
  export function bytesToHex(bytes: Uint8Array): string;
}
