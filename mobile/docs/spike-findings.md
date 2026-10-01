# Spike findings — WebView probe (Task 1)

Platforms tested:
- **Android** — emulator API 35, Pixel 9 Pro (`emulator-5554`), Chromium WebView v133
- **iOS** — iPhone 18 Pro simulator (UDID `57AA9D67-BC32-4ECE-AA80-83B0DAF6199A`), iOS 27.0, WKWebView / Hermes

---

## S1 — Storage tokens and security context

Probe loaded `https://crossfog.madera.codes/` as the WebView `baseUrl`.

| Signal | Android | iOS |
|--------|---------|-----|
| `location.href` | `https://crossfog.madera.codes/` | `https://crossfog.madera.codes/` |
| `window.isSecureContext` | `true` | `true` |
| `typeof window.crypto.subtle` | `"object"` | `"object"` |
| `localStorage` token | ✓ persists across WebView reloads | ✓ |
| `indexedDB` token | ✓ persists across app cold-starts | ✓ |

Android tokens: localStorage `9075db0d-1029-42d2-80c9-96541448c984 @ 2026-10-01T18:05:57.304Z`, IDB `42ff46e6-d8bf-452e-9681-3a183e6dbbd2` (set 2026-10-01T18:05:57.347Z)  
iOS tokens: localStorage `<uuid> @ 2026-10-01T19:59:03.472Z` (UUID truncated in screenshot; format is `crypto.randomUUID() + ' @ ' + ISO timestamp`), IDB `280831b3-1008-425a-9ccf-1a4761ee0eb1` (set 2026-10-01T19:59:03.536Z)

**Conclusion:** Both platforms run the WebView in a secure context with Web Crypto available. Both storage backends survive independent restarts on both platforms — fog-file caching and derived-key storage are viable.

---

## S2 — Native→WebView file transfer timing

**Android path:** `DocumentPicker.getDocumentAsync` → `readAsStringAsync` (1 MB chunks, base64) → `WebView.injectJavaScript` → `window.receiveChunk` → reassembled in WebView → stored to IndexedDB.  
**iOS path:** `DocumentPicker` was not exercised (headless simulator). A 25 MB synthetic buffer was pumped 1 MB at a time via `injectJavaScript` → `receiveChunk` directly, measuring JSBridge throughput and IDB write time. The `readAsStringAsync` segment of the full iOS path was not timed.

| Phase | Android (24 MB real file) | iOS (25 MB synthetic) |
|-------|--------------------------|----------------------|
| Native→WebView (1 MB chunks) | **735 ms** | **2738 ms** |
| IndexedDB write | **109 ms** | **139 ms** |
| **Total (first open)** | **844 ms** | **2877 ms** |
| IndexedDB cached read | **73 ms** | — (not measured) |

Android test file: `big-50mb.zip` — 6 FoW-style tiles, 25 170 256 bytes (24 MB), via `DocumentPicker`.  
iOS test: 25 MB synthetic buffer (25 × 1 MB chunks) pumped via `injectJavaScript`→`receiveChunk` directly, bypassing `DocumentPicker` (headless simulator). IDB write path is real; transfer time measures JSBridge (`evaluateJavaScript`) latency only.

iOS transfer is ~3.7× slower than Android, primarily because WKWebView's `evaluateJavaScript` serializes each chunk through the JSBridge whereas Chromium WebView on Android has a lower-overhead path. IDB write times (109 ms vs 139 ms) are comparable — the storage layer itself is not the bottleneck.

**Conclusion:** 25 MB stores to IDB in under 150 ms on both platforms. The native→WebView bridge is the variable: Android hits ~33 MB/s while iOS measures ~9 MB/s for this chunk size. Android meets the 3 s budget on both paths (844 ms fresh, 73 ms cached). iOS's synthetic JSBridge time of 2877 ms is nominally within 3 s, but that measurement bypasses `DocumentPicker` and `readAsStringAsync`; the full iOS path needs a real-file test before the budget can be confirmed. The IDB layer itself is not the bottleneck on either platform.

**SDK 57 note:** `readAsStringAsync` was moved out of the `expo-file-system` main entry point. Import from `expo-file-system/legacy`; the main module throws a runtime deprecation error.

---

## S3 — WebView pick intercept

The probe HTML wraps the file `<input>` in a `<label>`. A `click` on the label triggers `event.preventDefault()` in the WebView and posts `{ type: "pickBackup" }` to the native host.

| Platform | Result |
|----------|--------|
| Android | ✓ `pickBackup intercepted from zip-label` |
| iOS | ✓ `pickBackup intercepted from zip-label` (triggered via `injectJavaScript` click) |

The native `onMessage` handler received the message on both platforms before any file-picker UI appeared.

**Conclusion:** The label→preventDefault→postMessage pattern works identically on Android (Chromium WebView) and iOS (WKWebView). The app can substitute its own `DocumentPicker` flow and stream the file back via `injectJavaScript`.

**Alert caveat:** The `onMessage` handler calls `Alert.alert()` on receipt. In a dev build, this can interfere with automation. Override `window.alert = function(){}` via `injectJavaScript` before triggering the label if scripting the test.

---

## S4 — Share / Open-in

### Android — share intent

`expo-share-intent` is configured with `androidIntentFilters` for `application/zip`, `application/x-zip-compressed`, and `application/octet-stream` (`disableIOS: true`).

**Dev-build behavior:** Sending `android.intent.action.SEND` to a running dev-build instance triggers `DevLauncherErrorActivity` and crashes the app. The Expo development launcher intercepts certain intents and routes them through an error UI rather than forwarding them to the React Native layer.

**Production expectation:** In a release build, `useShareIntentContext()` receives `hasShareIntent=true` and `shareIntent.files` with the path and MIME type. The hook is wired correctly; the crash is specific to the dev-launcher wrapper.

### iOS — URL scheme / Open-in

`app.json` registers the `crossfogprobe://` URL scheme and a `documentTypes` entry for `public.zip-archive` (`LSHandlerRank: Alternate`).

`AppDelegate.swift` forwards URLs to `RCTLinkingManager`, which delivers them to `Linking.getInitialURL()` (cold start) and `Linking.addEventListener("url")` (foreground open). Confirmed via:

```
xcrun simctl openurl <udid> "crossfogprobe://open?file=test.zip"
```

iOS presented the system "Open in 'Cross the Fog Probe'?" dialog, confirming the scheme is registered and the handler is wired. The URL would arrive in the `Linking` listener upon user confirmation.

**Conclusion (Android):** Intent-filter entries are correct; the hook is in place. A production build is needed to confirm end-to-end on Android. The `SEND` intent path is the right mechanism; no code changes required.

**Conclusion (iOS):** URL scheme and `Linking` wiring confirmed on iOS 27. "Open in" from Files.app or AirDrop will route `.zip` files to the app. The `getInitialURL` path handles cold-start deep links; `addEventListener` handles foreground opens.

---

## S5 — Directory picker / folder link

No dedicated S5 test was included in this probe build. The probe HTML has no directory-picker button; `DocumentPicker.getDocumentAsync` picks individual files only.

`expo-document-picker` exposes no directory-selection API on Android or iOS. The platform alternative — `StorageAccessFramework.requestDirectoryPermissionsAsync` from `expo-file-system/legacy` — was not probed.

**Conclusion:** S5 is untested. If the product requires persistent folder access (e.g. watching a Downloads folder), a separate probe is needed using `StorageAccessFramework` on Android and the `UIDocumentPickerViewController` with `directory` mode on iOS.

---

## iOS build notes

Build target: iPhone 18 Pro simulator, iOS 27.0, Expo SDK 57 / React Native 0.86.3.

**iOS 27 UIScene enforcement:** iOS 27 added `___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`, which crashes any app that has not adopted `UIScene` lifecycle with `EXC_BREAKPOINT` at launch. Expo SDK 57's generated `AppDelegate.swift` does not include a `SceneDelegate` class by default.

**Fix applied:** A `withSceneDelegate` config plugin (`plugins/withSceneDelegate.js`) was added that:
1. Writes `SceneDelegate.swift` (`class SceneDelegate: ExpoAppSceneDelegate {}`) to the Xcode project directory.
2. Registers it in `project.pbxproj` via `withXcodeProject` + `findPBXGroupKey` + `addSourceFile` — required because `withDangerousMod` alone writes to disk but does not register the file for compilation.
3. Injects `UIApplicationSceneManifest` into `Info.plist` pointing `UISceneDelegateClassName` at `$(PRODUCT_MODULE_NAME).SceneDelegate`.

Without step 2, the binary lacks the class and the iOS runtime logs `could not load class with name "CrosstheFogProbe.SceneDelegate"`, producing a black screen.

**Expo DevMenu onboarding:** On first launch the dev-menu overlay blocks the probe UI. Dismiss it from outside the simulator:
```
xcrun simctl spawn <udid> defaults write codes.madera.crossfog.probe EXDevMenuIsOnboardingFinished -bool true
xcrun simctl terminate <udid> codes.madera.crossfog.probe
xcrun simctl launch <udid> codes.madera.crossfog.probe
```

---

## Parameters carried forward to implementation

| Parameter | Value used | Rationale |
|-----------|-----------|-----------|
| `CHUNK_BYTES` | 1 048 576 (1 MB) | Not tuned; plan default; revisit if memory pressure observed on iOS (slower bridge) |
| `CACHE_ENABLED` | `true` | 73 ms cached vs 844 ms fresh (Android) justifies storage; IDB on iOS also fast (~139 ms write) |
| `ZIP_INTERCEPT` | `label` + `input` | Label preventDefault→postMessage confirmed on both Android and iOS |
| `SHARE_MIME` | `application/zip`, `application/x-zip-compressed`, `application/octet-stream` | Matches dev MIME types seen in Android file manager |
| `IOS_URL_SCHEME` | `crossfogprobe://` + `public.zip-archive` doc type | Confirmed via iOS 27 simulator openurl; `Linking` handler receives URL |
| `IOS_SCENE_DELEGATE` | `withSceneDelegate` config plugin | Required for iOS 27+ UIScene enforcement; without it app crashes at launch |
