import type { ConfigContext, ExpoConfig } from "expo/config";
import shareMime from "./src/import/share-mime.json";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Cross the Fog",
  slug: "cross-the-fog",
  version: "0.1.0",
  scheme: "crossfog",
  userInterfaceStyle: "light",
  icon: "./assets/icon.png",
  android: {
    package: "codes.madera.crossfog",
    permissions: [],
    blockedPermissions: [
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.VIBRATE",
    ],
    adaptiveIcon: {
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
      backgroundColor: "#E6F4FE",
    },
    // React Navigation needs to handle back presses in JS; predictive back would let Android consume the gesture first.
    predictiveBackGestureEnabled: false,
  },
  ios: {
    bundleIdentifier: "codes.madera.crossfog",
    privacyManifests: {
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
          NSPrivacyAccessedAPITypeReasons: ["C617.1"],
        },
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
          NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
        },
      ],
    },
    infoPlist: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: "Zip archive",
          CFBundleTypeRole: "Viewer",
          LSHandlerRank: "Alternate",
          LSItemContentTypes: ["public.zip-archive"],
        },
      ],
      LSSupportsOpeningDocumentsInPlace: false,
    },
  },
  plugins: [
    "expo-router",
    "./plugins/withExpoSceneDelegate",
    ["expo-share-intent", { disableIOS: true, androidIntentFilters: shareMime }],
  ],
  extra: {
    eas: { projectId: "caaa478d-1167-481c-bbb5-0339a7fbfadb" },
    e2e: process.env.CROSSFOG_E2E === "1",
  },
  experiments: { typedRoutes: true },
});
