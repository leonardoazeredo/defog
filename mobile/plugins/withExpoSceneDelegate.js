const fs = require("fs");
const path = require("path");
const { withInfoPlist, withDangerousMod } = require("expo/config-plugins");

// iOS 26+ traps at launch without UIScene lifecycle adoption. Register Expo's scene delegate,
// which owns window creation and RN startup, so AppDelegate must stop doing both.
module.exports = (config) => {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "EXExpoAppSceneDelegate",
          },
        ],
      },
    };
    return c;
  });

  return withDangerousMod(config, [
    "ios",
    async (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, c.modRequest.projectName);
      const file = path.join(dir, "AppDelegate.swift");
      let src = fs.readFileSync(file, "utf8");
      // Already patched: prebuild without --clean reruns this mod on the same file.
      if (src.includes("ExpoReactNativeFactoryProvider")) return c;

      src = src.replace(
        "class AppDelegate: ExpoAppDelegate {",
        "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {",
      );
      // Left in place, this block would create a second window and RN instance next to the scene delegate's.
      const start = /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow[\s\S]*?#endif\n/;
      if (!start.test(src))
        throw new Error("withExpoSceneDelegate: AppDelegate startReactNative block not found");
      src = src.replace(start, "\n");
      fs.writeFileSync(file, src);
      return c;
    },
  ]);
};
