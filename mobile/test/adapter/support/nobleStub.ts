// Stands in for @noble/hashes/sha256 and /utils, which the page bundle leaves external (scripts/web/bundleAdapter.ts)
// and Vite cannot resolve. The boot test sets CRYPTO_SUBTLE, so nothing calls these.
export const sha256 = (): Uint8Array => new Uint8Array();
export const bytesToHex = (): string => "";
