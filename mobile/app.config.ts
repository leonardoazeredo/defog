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
    ["expo-share-intent", { disableIOS: true, androidIntentFilters: shareMime }],
  ],
  extra: { e2e: process.env.CROSSFOG_E2E === "1" },
  experiments: { typedRoutes: true },
});
