const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

// The saved fog is location history. For apps targeting Android 12+, allowBackup="false" alone
// still lets some manufacturers copy app data in a device-to-device transfer, so every domain is
// excluded by rule too.
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

const excludes = DOMAINS.map((d) => `    <exclude domain="${d}" path="."/>`).join("\n");

const EXTRACTION_RULES = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
${excludes}
  </cloud-backup>
  <device-transfer>
${excludes}
  </device-transfer>
</data-extraction-rules>
`;

// Android 11 and lower read this file. Android 12+ reads dataExtractionRules instead for apps
// targeting Android 12+, which this app does.
const BACKUP_RULES = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
${excludes}
</full-backup-content>
`;

// tools:replace keeps these values when a dependency's manifest sets one of them differently;
// without it the manifest merge fails with a conflict.
const REPLACED = [
  "android:allowBackup",
  "android:fullBackupContent",
  "android:dataExtractionRules",
];

function applyNoBackup(androidManifest) {
  const manifest = androidManifest.manifest;
  manifest.$ = { ...manifest.$, "xmlns:tools": "http://schemas.android.com/tools" };
  const app = manifest.application[0];
  const replaced = (app.$["tools:replace"] ?? "").split(",").filter(Boolean);
  app.$ = {
    ...app.$,
    "android:allowBackup": "false",
    "android:fullBackupContent": "@xml/crossfog_backup_rules",
    "android:dataExtractionRules": "@xml/crossfog_extraction_rules",
    "tools:replace": [...new Set([...replaced, ...REPLACED])].join(","),
  };
  return androidManifest;
}

module.exports = (config) => {
  config = withAndroidManifest(config, (c) => {
    c.modResults = applyNoBackup(c.modResults);
    return c;
  });

  return withDangerousMod(config, [
    "android",
    async (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "crossfog_extraction_rules.xml"), EXTRACTION_RULES);
      fs.writeFileSync(path.join(dir, "crossfog_backup_rules.xml"), BACKUP_RULES);
      return c;
    },
  ]);
};
module.exports.applyNoBackup = applyNoBackup;
module.exports.EXTRACTION_RULES = EXTRACTION_RULES;
module.exports.BACKUP_RULES = BACKUP_RULES;
