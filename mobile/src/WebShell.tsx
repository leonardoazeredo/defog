import Constants from "expo-constants";
import { Directory, Paths } from "expo-file-system";
import * as Linking from "expo-linking";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, BackHandler, Platform, StyleSheet, Text, ToastAndroid, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { WEB_HTML } from "../../generated/web.js";
import { createBackupFlow } from "./backup/backup.js";
import { createRestoreFlow } from "./backup/restore.js";
import { createSettingsChannel } from "./backup/settings.js";
import { reportDropped } from "./bridge/dropped.js";
import { decideNavigation, shouldOpenWindowExternally } from "./bridge/navigationPolicy.js";
import { openLink } from "./bridge/openLink.js";
import { pageConfigScript } from "./bridge/pageConfig.js";
import {
  inspectWebToNative,
  isTrustedSource,
  type NativeToWeb,
  ORIGIN,
} from "./bridge/protocol.js";
import { createSend, scheduleTask } from "./bridge/send.js";
import { type Controller, createController } from "./controller.js";
import { COPY } from "./copy.js";
import { pickE2eFixture } from "./e2e/fixturePicker.js";
import { createBackupFlows } from "./flows/backup.js";
import { type ComposedFlows, createFlows } from "./flows/compose.js";
import { createExportFlow } from "./flows/exportFlow.js";
import { createReloadGuard } from "./fog/reloadGuard.js";
import { createFogStore } from "./fog/store.js";
import { CHUNK_BYTES } from "./fog/transfer.js";
import { subscribeIncoming } from "./import/incomingQueue.js";
import { pickBackupFile } from "./import/pick.js";
import { createNativeWatchLink } from "./link/watchLink.js";
import { createScratch, pickRestoreFile, saveFileAs } from "./platform/backupPlatform.js";
import { createDatabase } from "./platform/database.js";
import { createExpoFileStore } from "./platform/expoFileStore.js";
import { createExportFs } from "./platform/exportFiles.js";
import { createOpenBackup } from "./platform/expoSqliteDriver.js";
import { createHistoryStores, withHistoryDb } from "./platform/historyStores.js";
import { clearShareCopies, makeReleaseSource, shareExport } from "./platform/nativeHandlers.js";
import { replaceDatabase } from "./platform/replaceDatabase.js";
import { sha256Hex } from "./platform/sha256.js";
import { copyFromUri } from "./platform/watchLinkModule.js";
import { PassphraseDialog, type PassphraseRequest } from "./ui/PassphraseDialog.js";
import type { PassphraseAnswer } from "./ui/passphraseForm.js";

// react-native-webview 14 defaults its props generic to `undefined`, which makes the props type
// `never` for a bare `WebView` type. Drop this alias if that default changes.
type ShellWebView = WebView<object>;

// Page background colour so safe areas match the page.
const PAGE_BG = "#e7e9ee";

const styles = StyleSheet.create({
  busyLayer: { alignItems: "center", justifyContent: "center" },
  busyCard: {
    alignItems: "center",
    paddingHorizontal: 22,
    paddingVertical: 18,
    borderRadius: 14,
    backgroundColor: "rgba(20, 24, 32, 0.82)",
  },
  busyText: { color: "#fff", fontSize: 15 },
});

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

function devAddActivity(flows: ComposedFlows, notify: (text: string) => void): () => Promise<void> {
  const { createDevAddActivity } =
    require("./dev/devActions.js") as typeof import("./dev/devActions.js");
  return createDevAddActivity({ run: flows.handOffNow }, notify);
}

function buildController(
  webViewRef: React.RefObject<ShellWebView | null>,
  setWebKey: (fn: (k: number) => number) => void,
  initialLoadDone: React.RefObject<boolean>,
  setBusy: (on: boolean) => void,
  askPassphrase: (mode: PassphraseRequest["mode"]) => Promise<PassphraseAnswer | null>,
): { controller: Controller; flows: ComposedFlows; send: (msg: NativeToWeb) => void } {
  const fogDir = new Directory(Paths.document, "fog");
  const fs = createExpoFileStore(fogDir);
  const store = createFogStore(fs, { sha256Hex, now: Date.now });
  const guard = createReloadGuard(fs);
  const releaseSource = makeReleaseSource({
    cache: Paths.cache.uri,
    inbox: `${Paths.document.uri}Inbox/`,
  });
  // A message sent while the page is not loaded is lost; the page asks again through `ready`.
  const send = createSend({
    post: (raw) => webViewRef.current?.postMessage(raw),
    schedule: scheduleTask,
  });
  const settings = createSettingsChannel({ send, timeoutMs: 5000 });
  const scratch = createScratch();
  scratch.clear();
  const openBackup = createOpenBackup();
  const backupFlows = createBackupFlows({
    backup: createBackupFlow({
      withDb: withHistoryDb,
      openBackup,
      fogStore: store,
      fs,
      scratch,
      settings,
      askPassphrase: () => askPassphrase("backup"),
      confirmUnencrypted: () =>
        confirmAlert(COPY.unencryptedTitle, COPY.unencryptedWarning, COPY.unencryptedConfirm),
      saveAs: saveFileAs,
      now: Date.now,
    }),
    restore: createRestoreFlow({
      pickFile: pickRestoreFile,
      copyFromUri,
      scratch,
      openBackup,
      replaceDatabase,
      fogStore: store,
      confirm: () =>
        confirmAlert(COPY.restoreConfirmTitle, COPY.restoreConfirmMessage, COPY.replaceEverything),
      askPassphrase: () => askPassphrase("restore"),
      settings,
    }),
    notify,
  });
  // A crash or a page reload mid-export leaves plaintext tiles in the cache; the next start removes them.
  const exportFlow = createExportFlow({
    fs: createExportFs(),
    saveAs: saveFileAs,
    notify,
    now: Date.now,
  });
  void exportFlow.clear();
  clearShareCopies();
  const flows = createFlows({
    link: createNativeWatchLink(),
    ...createHistoryStores(),
    send,
    backup: backupFlows,
    exportFlow,
    settings,
    now: Date.now,
  });
  const controller = createController({
    store,
    guard,
    fs,
    send,
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
    setBusy,
    now: Date.now,
    chunkBytes: CHUNK_BYTES,
    flows,
    ...(__DEV__ ? { devAddActivity: devAddActivity(flows, notify) } : {}),
  });
  return { controller, flows, send };
}

export function WebShell(): React.JSX.Element {
  const [webKey, setWebKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [passphraseRequest, setPassphraseRequest] = useState<PassphraseRequest | null>(null);
  const webViewRef = useRef<ShellWebView | null>(null);
  const initialLoadDone = useRef(false);

  // Build the controller and flows once; never rebuild them across re-renders.
  const builtRef = useRef<ReturnType<typeof buildController> | null>(null);
  if (builtRef.current === null) {
    builtRef.current = buildController(
      webViewRef,
      setWebKey,
      initialLoadDone,
      setBusy,
      (mode) =>
        new Promise((resolve) => {
          setPassphraseRequest({
            mode,
            resolve(answer) {
              setPassphraseRequest(null);
              resolve(answer);
            },
          });
        }),
    );
  }
  const { controller, flows, send } = builtRef.current;

  useEffect(() => {
    void controller.start();
  }, [controller]);

  // Hand-off runs at start and on every staged activity. It waits for the database to open; if the database is unavailable, offers stay staged until the next run.
  useEffect(() => flows.start(), [flows]);

  // Opens the database (shared with the hand-off) so the migration runs at startup and a lost key is surfaced; the open never creates an empty history over a lost key.
  useEffect(() => {
    createDatabase().then(
      (h) => {
        if (h.kind === "keyLost") Alert.alert(COPY.historyKeyLost);
      },
      (e) => {
        // Log the error name only: SQLite messages can include file paths, and logs must not carry location data.
        console.warn(
          "crossfog: history database did not open",
          e instanceof Error ? e.name : "unknown",
        );
        Alert.alert(COPY.historyOpenFailed);
      },
    );
  }, []);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        controller.onBackPressed();
        return true;
      });
      return () => sub.remove();
    }, [controller]),
  );

  // Subscribe to incoming files from share-to-app and Open-with.
  useEffect(() => {
    return subscribeIncoming((file) => void controller.onIncoming(file));
  }, [controller]);

  const userAgent = `CrossTheFog/${Constants.expoConfig?.version ?? "0"} (+https://madera.codes)`;
  const pageConfig = pageConfigScript(Constants.expoConfig?.extra?.nextgisOverpassKey);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: PAGE_BG }}>
      <WebView
        key={webKey}
        ref={webViewRef}
        source={{ html: WEB_HTML, baseUrl: ORIGIN }}
        {...(pageConfig ? { injectedJavaScriptBeforeContentLoaded: pageConfig } : {})}
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
            void openLink(event.url, Linking.openURL, notify);
          }
          return decision === "allow";
        }}
        onOpenWindow={(event) => {
          const url = event.nativeEvent.targetUrl;
          if (shouldOpenWindowExternally(url)) {
            void openLink(url, Linking.openURL, notify);
          }
        }}
        onMessage={(event) => {
          if (!isTrustedSource(event.nativeEvent.url)) return;
          const parsed = inspectWebToNative(event.nativeEvent.data);
          if (!parsed.ok) {
            reportDropped(parsed.drop, send);
            return;
          }
          void controller.onWebMessage(parsed.msg);
        }}
        onContentProcessDidTerminate={() => {
          void controller.onProcessGone();
        }}
        onRenderProcessGone={() => {
          void controller.onProcessGone();
        }}
        style={{ flex: 1, backgroundColor: PAGE_BG }}
      />
      <PassphraseDialog request={passphraseRequest} />
      {busy ? (
        <View style={[StyleSheet.absoluteFill, styles.busyLayer]} pointerEvents="none">
          <View style={styles.busyCard}>
            <Text style={styles.busyText}>{COPY.importing}</Text>
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}
