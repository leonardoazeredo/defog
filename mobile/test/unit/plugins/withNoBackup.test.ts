import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  applyNoBackup,
  EXTRACTION_RULES,
  BACKUP_RULES,
} = require("../../../plugins/withNoBackup.cjs");

type Attrs = Record<string, string>;
const sample = (appAttrs: Attrs = {}) => ({
  manifest: {
    $: {} as Attrs,
    application: [{ $: { "android:name": ".MainApplication", ...appAttrs } as Attrs }],
  },
});
const DOMAINS = [
  "root",
  "file",
  "database",
  "sharedpref",
  "external",
  "device_root",
  "device_file",
  "device_database",
  "device_sharedpref",
];

it("turns backup off and points both rule attributes at our files", () => {
  const m = applyNoBackup(sample());
  const app = m.manifest.application[0].$;
  expect(app["android:allowBackup"]).toBe("false");
  expect(app["android:fullBackupContent"]).toBe("@xml/crossfog_backup_rules");
  expect(app["android:dataExtractionRules"]).toBe("@xml/crossfog_extraction_rules");
  expect(app["tools:replace"].split(",").sort()).toEqual([
    "android:allowBackup",
    "android:dataExtractionRules",
    "android:fullBackupContent",
  ]);
  expect(m.manifest.$["xmlns:tools"]).toBe("http://schemas.android.com/tools");
});

it("keeps attributes another plugin already asked tools:replace to override", () => {
  const app = applyNoBackup(sample({ "tools:replace": "android:label" })).manifest.application[0].$;
  expect(app["tools:replace"].split(",").sort()).toEqual([
    "android:allowBackup",
    "android:dataExtractionRules",
    "android:fullBackupContent",
    "android:label",
  ]);
});

it.each(["cloud-backup", "device-transfer"])(
  "Android 12+ rules exclude every domain from %s",
  (section) => {
    const body = EXTRACTION_RULES.split(`<${section}>`)[1].split(`</${section}>`)[0];
    for (const d of DOMAINS) expect(body).toContain(`<exclude domain="${d}" path="."/>`);
  },
);

it("Android 11- rules exclude every domain", () => {
  for (const d of DOMAINS) expect(BACKUP_RULES).toContain(`<exclude domain="${d}" path="."/>`);
});
