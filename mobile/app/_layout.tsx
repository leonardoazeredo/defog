import { Stack } from "expo-router";
import { logCrash } from "../src/platform/crashLog.js";

// Capture unhandled JS errors to crash.log so they're readable via Xcode/ADB.
if (typeof ErrorUtils !== "undefined") {
  ErrorUtils.setGlobalHandler((error) => {
    void logCrash(error);
  });
}

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="about" options={{ presentation: "modal", title: "About" }} />
    </Stack>
  );
}
