import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface LicenseEntry {
  name: string;
  version: string;
  license: string;
}

interface PnpmLicenseRecord {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
}

// Verbatim from tilezen/joerd docs/attribution.md, its "Required attribution:" list (not the
// Mapzen-hosted one), so it can be re-diffed against that file when the providers update it.
const TERRAIN_ATTRIBUTION = [
  "ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;",
  "Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;",
  "Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;",
  "Canada terrain data contains information licensed under the Open Government Licence – Canada;",
  "Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;",
  "Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration",
  "Mexico terrain data source: INEGI, Continental relief, 2016;",
  "New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);",
  "Norway terrain data © Kartverket;",
  "United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved;",
  "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.",
];

export type ReadManifest = (packageDir: string) => { os?: unknown; cpu?: unknown; libc?: unknown };

export function parsePnpmLicenses(json: string, readManifest: ReadManifest): LicenseEntry[] {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "Expected pnpm licenses output to be a non-array object keyed by SPDX identifier",
    );
  }
  const byLicense = parsed as Record<string, unknown>;
  const entries: LicenseEntry[] = [];
  for (const [license, records] of Object.entries(byLicense)) {
    if (!Array.isArray(records)) throw new Error(`Expected array for license ${license}`);
    for (const record of records as PnpmLicenseRecord[]) {
      const dir = record.paths[0];
      if (dir === undefined) throw new Error(`Expected an install path for ${record.name}`);
      // A package that declares os, cpu or libc is taken to be one platform's build of a listed
      // parent with the same license (lightningcss-darwin-arm64 for lightningcss). pnpm installs
      // only the host's build, so keeping it would make the file differ by build machine. The
      // parent is not checked: a platform-only package with no listed parent would lose its
      // license line silently. The first install path decides for every version of the record.
      const { os, cpu, libc } = readManifest(dir);
      if (os !== undefined || cpu !== undefined || libc !== undefined) continue;
      for (const version of record.versions) {
        entries.push({ name: record.name, version, license });
      }
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return entries;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const { execSync } = await import("node:child_process");
  const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  const defogLicense = readFileSync(resolve(ROOT, "LICENSE"), "utf-8").trim();
  const leafletLicense = readFileSync(
    resolve(mobileDir, "licenses/leaflet-LICENSE.txt"),
    "utf-8",
  ).trim();
  const pakoLicense = readFileSync(resolve(mobileDir, "licenses/pako-LICENSE.txt"), "utf-8").trim();
  const brouterLicense = readFileSync(
    resolve(mobileDir, "licenses/brouter-LICENSE.txt"),
    "utf-8",
  ).trim();

  const pnpmJson = execSync("pnpm licenses list --prod --json", { cwd: mobileDir }).toString();
  const dependencies = parsePnpmLicenses(pnpmJson, (dir) =>
    JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8")),
  );

  const out = {
    defog: defogLicense,
    leaflet: leafletLicense,
    pako: pakoLicense,
    brouter: brouterLicense,
    terrain: TERRAIN_ATTRIBUTION,
    dependencies,
  };
  const dest = resolve(ROOT, "generated/licenses.json");
  writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(`wrote ${dest} (${dependencies.length} deps)`);
}
