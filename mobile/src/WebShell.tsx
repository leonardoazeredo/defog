import Constants from "expo-constants";
import { Directory, Paths } from "expo-file-system";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, BackHandler, Platform, ToastAndroid } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { WEB_HTML } from "../../generated/web.js";
import { decideNavigation, shouldOpenWindowExternally } from "./bridge/navigationPolicy.js";
import { encode, isTrustedSource, ORIGIN, parseWebToNative } from "./bridge/protocol.js";
import { type Controller, createController } from "./controller.js";
import { COPY } from "./copy.js";
import { pickE2eFixture } from "./e2e/fixturePicker.js";
import { createRestoreGuard } from "./fog/restoreGuard.js";
import { createFogStore } from "./fog/store.js";
import { CHUNK_BYTES } from "./fog/transfer.js";
import { subscribeIncoming } from "./import/incomingQueue.js";
import { pickBackupFile } from "./import/pick.js";
import { createExpoFileStore } from "./platform/expoFileStore.js";
import { makeReleaseSource, shareExport } from "./platform/nativeHandlers.js";
import { sha256Hex } from "./platform/sha256.js";

// Page background colour so safe areas match the page.
const PAGE_BG = "#e7e9ee";

function confirmAlert(
  title: string,
  message: string | undefined,
  confirmLabel: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: COPY.cancel, style: "cancel", onPress: () => resolve(false) },
      { text: confirmLabel, onPress: () => resolve(true) },
    ]);
  });
}

function notify(text: string): void {
  if (Platform.OS === "android") {
    ToastAndroid.show(text, ToastAndroid.SHORT);
  } else {
    Alert.alert(text);
  }
}

function buildController(
  webViewRef: React.RefObject<WebView | null>,
  setWebKey: (fn: (k: number) => number) => void,
  initialLoadDone: React.RefObject<boolean>,
): Controller {
  const fogDir = new Directory(Paths.document, "fog");
  const fs = createExpoFileStore(fogDir);
  const store = createFogStore(fs, { sha256Hex, now: Date.now });
  const guard = createRestoreGuard(fs);
  const releaseSource = makeReleaseSource({
    cache: Paths.cache.uri,
    inbox: `${Paths.document.uri}Inbox/`,
  });
  return createController({
    store,
    guard,
    fs,
    send(msg) {
      webViewRef.current?.postMessage(encode(msg));
    },
    remount() {
      initialLoadDone.current = false;
      setWebKey((k) => k + 1);
    },
    pickFile: Constants.expoConfig?.extra?.e2e === true ? pickE2eFixture : pickBackupFile,
    confirmReplace: (name) => confirmAlert(COPY.replaceTitle(name), undefined, COPY.replace),
    confirmClear: () => confirmAlert(COPY.clearTitle, COPY.clearMessage, COPY.clear),
    notify,
    shareExport,
    openExternal: async (url) => {
      await Linking.openURL(url);
    },
    openAbout() {
      router.push("/about");
    },
    exitApp: BackHandler.exitApp,
    releaseSource,
    now: Date.now,
    chunkBytes: CHUNK_BYTES,
  });
}

export function WebShell(): React.JSX.Element {
  const [webKey, setWebKey] = useState(0);
  const webViewRef = useRef<WebView | null>(null);
  const initialLoadDone = useRef(false);

  // Lazy-initialise the controller once; never rebuild it across re-renders.
  const controllerRef = useRef<Controller | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = buildController(webViewRef, setWebKey, initialLoadDone);
  }
  const controller = controllerRef.current;

  useEffect(() => {
    void controller.start();
  }, [controller]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      controller.onBackPressed();
      return true;
    });
    return () => sub.remove();
  }, [controller]);

  // Subscribe to incoming files from share-to-app and Open-with.
  useEffect(() => {
    return subscribeIncoming((file) => void controller.onIncoming(file));
  }, [controller]);

  const userAgent = `CrossTheFog/${Constants.expoConfig?.version ?? "0"} (+https://madera.codes)`;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: PAGE_BG }}>
      <WebView
        key={webKey}
        ref={webViewRef}
        source={{ html: WEB_HTML, baseUrl: ORIGIN }}
        originWhitelist={["*"]}
        applicationNameForUserAgent={userAgent}
        domStorageEnabled
        allowFileAccess={false}
        allowsBackForwardNavigationGestures={false}
        webviewDebuggingEnabled={__DEV__}
        onLoadEnd={() => {
          initialLoadDone.current = true;
        }}
        onShouldStartLoadWithRequest={(event) => {
          const decision = decideNavigation(event.url, initialLoadDone.current);
          if (decision === "external") {
            void Linking.openURL(event.url);
          }
          return decision === "allow";
        }}
        onOpenWindow={(event) => {
          const url = event.nativeEvent.targetUrl;
          if (shouldOpenWindowExternally(url)) {
            void Linking.openURL(url);
          }
        }}
        onMessage={(event) => {
          if (!isTrustedSource(event.nativeEvent.url)) return;
          const msg = parseWebToNative(event.nativeEvent.data);
          if (!msg) {
            console.warn("crossfog: dropped invalid message");
            return;
          }
          void controller.onWebMessage(msg);
        }}
        onContentProcessDidTerminate={() => {
          void controller.onProcessGone();
        }}
        onRenderProcessGone={() => {
          void controller.onProcessGone();
        }}
        style={{ flex: 1, backgroundColor: PAGE_BG }}
      />
    </SafeAreaView>
  );
}
