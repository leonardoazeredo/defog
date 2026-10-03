const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Expose the monorepo root to Metro so it can resolve imports from generated/ (one level above mobile/).
config.watchFolders = [path.resolve(__dirname, "..")];

config.resolver.assetExts.push("zip");

// TypeScript node16 moduleResolution writes .js extensions for .ts files;
// Metro doesn't remap them automatically, so we try .ts/.tsx before failing.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.endsWith(".js")) {
    for (const ext of [".ts", ".tsx"]) {
      try {
        return context.resolveRequest(context, moduleName.slice(0, -3) + ext, platform);
      } catch {}
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
