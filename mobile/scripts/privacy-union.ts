import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const podsDir = resolve(mobileDir, "ios/Pods");

const xcprivacyFiles = execSync(`find "${podsDir}" -name "PrivacyInfo.xcprivacy"`, {
  encoding: "utf-8",
})
  .split("\n")
  .filter(Boolean);

interface ApiType {
  NSPrivacyAccessedAPIType: string;
  NSPrivacyAccessedAPITypeReasons: string[];
}

const union = new Map<string, Set<string>>();

for (const file of xcprivacyFiles) {
  const json = execSync(`plutil -convert json -o - "${file}"`, { encoding: "utf-8" });
  const plist = JSON.parse(json) as { NSPrivacyAccessedAPITypes?: ApiType[] };
  for (const entry of plist.NSPrivacyAccessedAPITypes ?? []) {
    const reasons = union.get(entry.NSPrivacyAccessedAPIType) ?? new Set<string>();
    for (const r of entry.NSPrivacyAccessedAPITypeReasons) reasons.add(r);
    union.set(entry.NSPrivacyAccessedAPIType, reasons);
  }
}

const result = {
  NSPrivacyAccessedAPITypes: [...union.entries()].map(([type, reasons]) => ({
    NSPrivacyAccessedAPIType: type,
    NSPrivacyAccessedAPITypeReasons: [...reasons],
  })),
};

console.log(JSON.stringify({ privacyManifests: result }, null, 2));
console.log("\nPaste the above into ios.privacyManifests in app.config.ts.");
