import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildCsp, scriptHash } from "../../../scripts/web/csp.js";

it("hashes like the browser", () =>
  expect(scriptHash("alert(1)")).toBe(
    `'sha256-${createHash("sha256").update("alert(1)").digest("base64")}'`,
  ));

it("builds the exact policy", () =>
  expect(buildCsp(["'sha256-a'", "'sha256-b'"])).toBe(
    "default-src 'none'; script-src 'sha256-a' 'sha256-b'; style-src 'unsafe-inline'; img-src data: https://tile.openstreetmap.org https://*.tile-cyclosm.openstreetmap.fr; connect-src https://brouter.de https://overpass-api.de; base-uri 'none'; form-action 'none'",
  ));
