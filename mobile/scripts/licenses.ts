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
  license: string;
}

export function parsePnpmLicenses(json: string): LicenseEntry[] {
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

  const pnpmJson = execSync("pnpm licenses list --prod --json", { cwd: mobileDir }).toString();
  const dependencies = parsePnpmLicenses(pnpmJson);

  const out = { defog: defogLicense, leaflet: leafletLicense, pako: pakoLicense, dependencies };
  const dest = resolve(ROOT, "generated/licenses.json");
  writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(`wrote ${dest} (${dependencies.length} deps)`);
}
