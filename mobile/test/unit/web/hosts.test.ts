import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { scanHosts, unknownHosts } from "../../../scripts/web/hosts.js";

function readAppSources(): string[] {
  const root = resolve(import.meta.dirname, "../../../..");
  const appDir = resolve(root, "app");
  const srcFiles = readdirSync(resolve(appDir, "src")).map((f) =>
    readFileSync(resolve(appDir, "src", f), "utf-8"),
  );
  return [readFileSync(resolve(appDir, "index.html"), "utf-8"), ...srcFiles];
}

it.skipIf(!!process.env.STRYKER_MUTATOR_WORKER)("finds exactly the reviewed hosts in app/", () => {
  const found = scanHosts(readAppSources());
  expect(found).toEqual([
    "*.tile-cyclosm.openstreetmap.fr",
    "brouter.de",
    "drive.google.com",
    "onedrive.live.com",
    "overpass-api.de",
    "szapalak.goatcounter.com",
    "tile.openstreetmap.org",
    "www.google.com",
    "www.opengis.net",
    "www.topografix.com",
  ]);
  expect(unknownHosts(found)).toEqual([]);
});

it("flags a new host", () =>
  expect(unknownHosts(scanHosts(['fetch("https://evil.example/x")']))).toEqual(["evil.example"]));
