# Cross the Fog: mobile app design

Status: draft for review
Branch: `cross-the-fog` on `leonardoazeredo/defog` (fork of `szalapak/defog`)

## 1. Intent

**What was asked for**
- A mobile app for Android and iOS built from the defog web app, reaching the Play Store and the App Store eventually. This round is an MVP.
- React Native. The MVP wraps and reuses the existing web code; a native rewrite is considered only if the app gets traction.
- Full feature parity with the web app: load fog, show fog, Streets in fog, draw a route, suggest routes.
- The least technical debt possible, built on the stack and conventions of the owner's other projects.
- `app/` stays mergeable with upstream (`szalapak/defog`).
- No location features in the MVP.
- Name: **Cross the Fog**. Publisher domain: `madera.codes`.

**What this design assumes**
- A Fog of World backup is at most tens of MB.
- The owner tests on their own devices before any store submission.

**Success for the MVP**
- On a phone, a user imports a Fog of World backup once. Every later launch shows their fog without re-importing, and every web feature works.
- A GPX/KML export reaches the system share sheet.
- `git merge upstream/main` needs no conflict resolution in `app/`, and a breaking upstream change fails the build instead of the running app.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Expo SDK 57 with Continuous Native Generation: no `android/` or `ios/` folders committed, native config only through `app.config.ts` and config plugins | The React Native team recommends a framework, and Expo is the one it names. Generated native folders are the biggest tech-debt reducer on SDK upgrades. SDK 57 is the current stable release and the one the owner's `chase-cashew` app uses. Moving to SDK 58 is a separate change after it's stable. |
| D2 | A single `react-native-webview` renders a bundled, self-contained copy of `app/` | defog already has a complete mobile UI: a bottom sheet under 720px, touch-sized pins, and touch dragging. Native maps can't draw the fog without an unproven workaround (MapLibre Native can't generate tiles on demand). |
| D3 | `app/` is never edited. A **web adapter** script injected before the page loads adds the mobile behaviour | Keeps upstream merges trivial. |
| D4 | Fog persistence lives in the adapter: IndexedDB inside the WebView holds the imported zip | The zip never crosses the native bridge, so large payloads aren't a problem. The fallback is in §6. |
| D5 | The build fails if the page elements the adapter relies on are missing (hook check) | Upstream changes break the build rather than users. |
| D6 | App ID `codes.madera.crossfog` (Android package and iOS bundle ID). Display name "Cross the Fog". | Reverse DNS of `madera.codes`, which the owner owns. It can't change after the first store upload. |
| D7 | No location permission of any kind, and Android's location permissions are explicitly blocked | Not needed for the MVP. This avoids Play's location declaration and the iOS location prompt text. |
| D8 | Tooling follows the owner's convention: pnpm (`minimumReleaseAge`, `trustPolicy: no-downgrade`), strict TypeScript, Biome, Vitest, Stryker, lefthook, knip, and Maestro for end-to-end tests | Matches the owner's other projects. Biome replaces ESLint. The React Compiler lint rules in `eslint-config-expo` are dropped, since there is almost no React code. |
| D9 | expo-router with two routes: `index` (the map) and `about` (a modal) | Expo's default router, and enough for two screens. |
| D10 | `mobile/` is a standalone package with no workspace. It reads `../app` only at build time. | Nothing to link, and no Metro setup across folders. |

## 3. Architecture

```
defog/
  app/, bench/, README.md …   upstream, untouched
  mobile/
    app.config.ts             name, IDs, plugins, user agent, blocked permissions
    app/                      expo-router routes: _layout.tsx, index.tsx, about.tsx
    src/
      bridge/protocol.ts      message types + Zod schemas (shared by native and adapter)
      bridge/nativeHandlers.ts  export → share sheet, openExternal, about, back
      WebShell.tsx            the WebView, safe-area padding, the Android back button
    web-adapter/              TS bundled into the injected script
      index.ts                entry: installs every hook
      persistence.ts          IndexedDB save/restore of the zip
      downloads.ts            captures object-URL downloads → export message
      links.ts                window.open / target=_blank → openExternal
      back.ts                 handles native "back" (closes the bottom sheet)
      chrome.ts               renames the brand, adds "Clear saved fog" and "About", hides unsupported inputs
    scripts/build-web.ts      app/ → generated/web.ts (the self-contained HTML as a string)
    test/fixtures/            generator for a synthetic Fog of World backup
    .maestro/                 end-to-end flows
    docs/superpowers/         this spec and the plan
```

### 3.1 Web build (`scripts/build-web.ts`)
- Input: `../app/index.html` plus the local `<link>` and `<script src>` files it references (`vendor/*`, `src/*`).
- Output: `mobile/generated/web.ts`, which exports `WEB_HTML: string`. It's a single HTML document with every local stylesheet and script inlined, and the web adapter inlined as the first script in `<head>`. `generated/` is gitignored and rebuilt by a `prebuild`/`predev` script.
- Transformations, each covered by a test:
  1. Remove the GoatCounter `<script>` (it has a `data-goatcounter` attribute).
  2. Inline every same-origin `<link rel=stylesheet>` and `<script src>`. Absolute `http(s):` and protocol-relative `//` script sources are removed.
  3. Inject the adapter.
- **Hook check:** the build fails, naming the missing hook, if any of these are absent: the elements `#zip`, `#folder`, `#loadStatus`, `#sidebar` and `#brandName` in `app/index.html`, or the success text `tiles loaded ✓` in `app/src/main.js`.

### 3.2 Native shell
- `WebShell` renders `<WebView source={{ html: WEB_HTML, baseUrl: ORIGIN }} />`. `ORIGIN` is a fixed https URL that belongs to us, `https://app.crossfog.madera.codes/`, and is never actually requested. It gives `localStorage` and IndexedDB a stable origin. The test build (§6) verifies this.
- The WebView user agent ends in `CrossTheFog/<version> (+https://madera.codes)`, as the OSM tile policy requires.
- Safe areas: the screen runs edge to edge and the WebView is padded with `react-native-safe-area-context` insets. The page is not changed.
- File inputs rely on react-native-webview's built-in `<input type=file>` support.
- Any navigation away from `ORIGIN` (link clicks, `window.open`, `target=_blank`) is cancelled and handed to `Linking.openURL`.
- Android back button: native sends `back`. If the adapter replies `handled: false`, the app exits.

### 3.3 Bridge protocol (`src/bridge/protocol.ts`)
Every message is JSON `{ v: 1, type, ...payload }`, and both sides validate it with Zod. A message that fails validation is dropped and logged, never acted on.

| Direction | type | Payload | Effect |
|---|---|---|---|
| web → native | `ready` | — | The page and adapter have loaded |
| web → native | `export` | `filename`, `mime`, `text` | Native writes the text to a cache file and calls `Sharing.shareAsync` (with `mimeType` on Android and the GPX/KML UTI on iOS) |
| web → native | `openExternal` | `url` (http/https only) | `Linking.openURL` |
| web → native | `openAbout` | — | Opens the `about` modal |
| web → native | `back:result` | `handled: boolean` | If false, `BackHandler.exitApp()` |
| native → web | `back` | — | Adapter closes the bottom sheet if it's open |

### 3.4 Web adapter behaviour
- **Persistence:** a capture-phase `change` listener on `document` (installed from `<head>`, so it runs before defog's own `#zip` handler) stores `{ name, bytes, savedAt }` in IndexedDB (`crossfog` database, `backup` store, single key `current`). On `DOMContentLoaded`, if a record exists, the adapter builds a `File` from it, assigns it to `#zip` using a `DataTransfer`, and fires `change`. That event is flagged so it isn't saved again. defog's own `loadFromZip` then does the actual loading.
- **Load outcome:** the adapter watches `#loadStatus` with a `MutationObserver`. A load has **succeeded** when the text contains `tiles loaded ✓`. Any other final text after a restore means it **failed**.
- **Clear saved fog:** deletes the record and reloads the page.
- **Downloads:** `URL.createObjectURL` is wrapped so the adapter keeps a map from object URL to Blob. Clicks on `<a download>` whose `href` is in that map are cancelled; the adapter reads the Blob's text and sends `export`. This covers `route.js` `saveBlob` and `export.js` `download` without changing them.
- **Chrome:** `#brandName` text becomes `CROSS THE FOG`. "Clear saved fog" and "About" buttons are added after `#loadStatus`. `#folder`'s label is hidden when the test build finds directory picking unusable on that platform.

### 3.5 About screen
- "Cross the Fog is based on defog by szalapak", with a link and the full MIT notice.
- Leaflet (BSD-2-Clause), pako (MIT), and OpenStreetMap (© OpenStreetMap contributors, ODbL).
- A list of the app's own dependency licenses, generated at build time.
- The app version.

## 4. Store baseline (built into the MVP now, even though submission comes later)
- Android: targets API 36 (the Play requirement since 2026-08-31) and runs edge to edge. It declares only `INTERNET`, and all location permissions are blocked in `app.config.ts`. The 16 KB page-size check is run on a release build.
- iOS: built with Xcode 26. `privacyManifests` in `app.config.ts` declares the required-reason APIs that Expo's Apple privacy guide lists for the modules used. There are no usage-description strings, because no protected permissions are requested.
- Not in the MVP: store listings, the privacy policy page (planned for `madera.codes`), a trademark search for "Cross the Fog" (USPTO/EUIPO classes 9 and 42), a commercial tile provider, and crash reporting.
- MVP distribution: EAS `preview` builds for Android (APK) and local development builds on the owner's iPhone.

## 5. Features explicitly out of the MVP
Location and the "you are here" dot; share-to-app import; onboarding screens; dark mode; analytics; state libraries; OTA updates (EAS Update); and any native reimplementation of defog's logic.

## 6. Test build (the plan's first task, throwaway code)
The test build answers these questions on a real Android device and a real iPhone. Each has a pass criterion and a decided fallback:

| # | Question | Pass | Fallback if it fails |
|---|---|---|---|
| S1 | Do `localStorage` and IndexedDB under `baseUrl` survive app restarts and reinstall-over-update? | The same record is present after a force-quit and after installing a newer build over the old one | Load the HTML from a native asset folder (`file://`) with file access allowed, which gives a stable file origin |
| S2 | Can IndexedDB hold a 50 MB zip, restoring it and loading it through `#zip` in a reasonable time? | Restore and load finish in under 10 s on a mid-range Android device | Store the zip natively in `Paths.document` and send it in 1 MB base64 chunks |
| S3 | Does `<input type=file accept=.zip>` open the system picker? | The picker opens and returns a readable `File` | Native `expo-document-picker`, then the file is fed to `#zip` through the bridge |
| S4 | Does `webkitdirectory` work in the WebView? | Picking a `Sync` folder loads tiles | The folder picker is hidden on that platform (§3.4) |
| S5 | Linked Sync folder: can a picked cloud folder (iOS: iCloud Drive; Android: SAF via Dropbox or OneDrive) be re-read after a restart without picking it again? | The tiles load on the next launch without a prompt | The feature is dropped from the MVP on that platform and becomes a later feature |

If S5 passes on a platform, the MVP gains a **Link Sync folder** action on that platform. It remembers the folder permission (a security-scoped bookmark on iOS, a persistable SAF permission on Android) and, on each launch, feeds the folder's files into `#folder`. The plan adds that work only for platforms where S5 passed.

## 7. Error handling
- Import errors: defog's own `#loadStatus` messages are shown as they are.
- A saved record that fails to load (see "Load outcome" in §3.4): the adapter deletes the record so a bad backup doesn't break every launch, and leaves defog's message on screen.
- IndexedDB write failure (for example, a quota limit): the fog stays loaded for this session, and the status reads "Loaded, but couldn't be saved for next time."
- Export failure or a cancelled share: a native toast on failure; a cancel is silent.
- Invalid bridge messages are dropped (§3.3).
- If the WebView content process dies (`onContentProcessDidTerminate` on iOS, `onRenderProcessGone` on Android), the WebView reloads, and the saved fog restores through the normal launch path.

## 8. Testing
- **Vitest + jsdom** for `web-adapter/*`, `src/bridge/protocol.ts` and `scripts/build-web.ts`. Stryker runs over the same code with a break threshold of 80%.
  - Adapter:
    - save/restore round trip with `fake-indexeddb`, where the restore event isn't saved again
    - download capture for both upstream download functions (`route.js` `saveBlob` and `export.js` `download`)
    - external links
    - back handling (sheet open → handled; closed → not handled)
    - brand rename and injected buttons
    - quota-failure message
    - a corrupt saved record is deleted
  - Build:
    - GoatCounter removed
    - no external `<script src>` or `<link>` left
    - the adapter is the first script
    - the hook check fails naming each missing hook, including the success text
  - Protocol: every message type round-trips; malformed messages are rejected.
- **Synthetic fixture:** `test/fixtures/make-backup.ts` builds a small valid Fog of World zip covering a made-up area. It follows the tile format in `app/src/parser.js`. **Real Sync data is never committed.**
- **Maestro** on both platforms:
  - import the fixture, then "tiles loaded ✓"
  - restart the app, then the fog is back without re-importing
  - draw a route, then Export GPX, then the share sheet opens
  - About opens and shows the defog credit
- **Manual device checklist:**
  - a real multi-MB backup
  - share targets (Files, Drive, Strava)
  - the linked Sync folder, if built
  - the 16 KB page-size check
- **Upstream merge check:** after every `git merge upstream/main`, run the web build and the test suite, and never resolve a conflict inside `app/`.
