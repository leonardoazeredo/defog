const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Uint8Array(128).fill(255);
for (let i = 0; i < CHARS.length; i++) LOOKUP[CHARS.charCodeAt(i)] = i;

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const rem = bytes.length - i;
    out += CHARS[b0 >> 2];
    out += CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += rem > 1 ? CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += rem > 2 ? CHARS[b2 & 63] : "=";
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(text)) {
    throw new Error("Invalid base64");
  }
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const len = (text.length / 4) * 3 - pad;
  const out = new Uint8Array(len);
  let p = 0;
  for (let i = 0; i < text.length - (pad > 0 ? 4 : 0); i += 4) {
    const n =
      (LOOKUP[text.charCodeAt(i)] << 18) |
      (LOOKUP[text.charCodeAt(i + 1)] << 12) |
      (LOOKUP[text.charCodeAt(i + 2)] << 6) |
      LOOKUP[text.charCodeAt(i + 3)];
    out[p++] = (n >> 16) & 255;
    if (p < len) out[p++] = (n >> 8) & 255;
    if (p < len) out[p++] = n & 255;
  }
  if (pad > 0) {
    const i = text.length - 4;
    const c0 = LOOKUP[text.charCodeAt(i)];
    const c1 = LOOKUP[text.charCodeAt(i + 1)];
    const c2 = pad < 2 ? LOOKUP[text.charCodeAt(i + 2)] : 0;
    if (c0 === 255 || c1 === 255 || (pad < 2 && c2 === 255)) {
      throw new Error("Invalid base64");
    }
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6);
    out[p++] = (n >> 16) & 255;
    if (pad < 2 && p < len) out[p++] = (n >> 8) & 255;
  }
  return out;
}
