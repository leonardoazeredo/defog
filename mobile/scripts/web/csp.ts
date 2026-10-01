import { createHash } from "node:crypto";
import { HOST_POLICY } from "./hostPolicy.js";

export function scriptHash(code: string): string {
  return `'sha256-${createHash("sha256").update(code).digest("base64")}'`;
}

export function buildCsp(scriptHashes: string[]): string {
  const imgs = ["data:", ...HOST_POLICY.img.map((h) => `https://${h}`)].join(" ");
  const connects = HOST_POLICY.connect.map((h) => `https://${h}`).join(" ");
  return [
    "default-src 'none'",
    `script-src ${scriptHashes.join(" ")}`,
    "style-src 'unsafe-inline'",
    `img-src ${imgs}`,
    `connect-src ${connects}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
