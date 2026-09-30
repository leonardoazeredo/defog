# Cross the Fog: mobile app design

Status: draft for review (revision 2, after the council review)
Branch: `cross-the-fog` on `leonardoazeredo/defog` (fork of `szalapak/defog`)

## 1. Intent

**What was asked for**
- A mobile app for Android and iOS built from the defog web app, reaching the Play Store and the App Store eventually. This round is an MVP.
- React Native. The MVP wraps and reuses the existing web code; a native rewrite is considered only if the app gets traction.
- Full feature parity with the web app: load fog, show fog, Streets in fog, draw a route, suggest routes.
- Share-to-app import is part of the MVP.
- The least technical debt possible, built on the stack and conventions of the owner's other projects.
- `app/` stays mergeable with upstream (`szalapak/defog`).
- No location features in the MVP.
- Name: **Cross the Fog**. Publisher domain: `madera.codes`.

**What the MVP is for:** the owner uses it on their own devices to find bugs and UI/UX opportunities. Traction, store submission and the rewrite question are revisited when planning 1.0 (§11).

**What this design assumes**
- A Fog of World backup is at most tens of MB.
- The owner may not have a paid Apple Developer membership, so nothing in the MVP requires one.

**Success for the MVP**
- The user imports a backup once, with the picker or by sharing it to the app. Every later launch shows their fog without re-importing, and every web feature works.
- **Saved fog is never lost silently.** It survives restarts, app updates and the WebView's storage being evicted, and a failed load never deletes it automatically.
- A GPX/KML export reaches the system share sheet.
- `git merge upstream/main` needs no conflict resolution in `app/`, and a breaking upstream change fails the build instead of the running app.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Expo SDK 57 with Continuous Native Generation: no `android/` or `ios/` folders committed, native config only through `app.config.ts` and config plugins | The React Native team recommends a framework, and Expo is the one it names. Generated native folders are the biggest tech-debt reducer on SDK upgrades. Moving to SDK 58 is a separate change after it's stable. |
| D2 | A single `react-native-webview` renders a bundled, self-contained copy of `app/` | defog already has a complete mobile UI. MapLibre Native can't generate fog tiles on demand. |
| D3 | `app/` is never edited. A **web adapter** injected into the page adds the mobile behaviour | Keeps upstream merges trivial. |
| D4 | **The durable copy of the fog is a native file** in the app's documents directory. The WebView's IndexedDB only caches it. | WebView storage is best-effort and can be evicted. A native file is removed only by the user or by uninstalling the app. |
| D5 | The build fails when anything the adapter relies on is missing. This is checked by **running the generated page**, not by searching its text. | A text search misses reworded messages and changed behaviour. |
| D6 | App ID `codes.madera.crossfog` (Android package and iOS bundle ID) | Reverse DNS of `madera.codes`. It can't change after the first store upload. |
| D7 | No location permission of any kind, and Android's location permissions are explicitly blocked | Not needed for the MVP. |
| D8 | Tooling: pnpm (`minimumReleaseAge`, `trustPolicy: no-downgrade`), strict TypeScript, Biome, Vitest, Stryker, lefthook, knip, Playwright (build-time contract check) and Maestro | Matches the owner's other projects. |
| D9 | expo-router with the routes `index` (the map) and `about` (a modal), plus `+native-intent` for files arriving from other apps | Expo's default router. |
| D10 | `mobile/` is a standalone package that reads `../app` only at build time | Nothing to link, and no Metro setup across folders. |
| D11 | The storage origin is `https://crossfog.invalid/`. It is permanent, like D6. | `.invalid` is reserved (RFC 6761) and can never resolve, so nothing from the network can ever be served into the page that holds the user's location history. The origin keys the WebView's storage; because of D4, changing it later would lose only display settings and the cache. |
| D12 | The generated page carries a strict Content Security Policy that lists the only hosts it may contact | Upstream code runs next to the user's location history, and the policy limits where any code in the page can send data. |
| D13 | All imports go through native code. The page's "…or a .zip" button opens the native document picker, and shared files arrive natively. | Native code must hold the durable copy (D4), so the zip never has to travel from the page to native. |
| D14 | Share-to-app on iOS registers the app for `.zip` documents (`CFBundleDocumentTypes`, no share extension). On Android it uses `expo-share-intent` with `disableIOS`. | iOS document types need no extension target and no App Group, so they work without a paid account. Android needs native code to receive shared files, and expo-share-intent provides it. |
| D15 | The page is reset by **remounting** the WebView, never by calling `reload()` | Reloading a page loaded from an HTML string may make WKWebView fetch the base URL. Remounting always starts from the bundled HTML. |

## 3. Architecture

```
defog/
  app/, bench/, README.md …      upstream, untouched
  mobile/
    app.config.ts                name, IDs, plugins, document types, user agent, blocked permissions
    app/                         routes: _layout.tsx, index.tsx, about.tsx, +native-intent.tsx
    src/
      bridge/protocol.ts         message types + Zod schemas (shared by native and adapter)
      bridge/nativeHandlers.ts   export → share sheet, openExternal, about, back
      fog/store.ts               durable copy: pending/current files, fingerprint, promotion
      fog/transfer.ts            chunked native → web transfer
      fog/restoreGuard.ts        crash-loop breaker
      import/pick.ts             native document picker
      import/incoming.ts         share-to-app intake (iOS open-URL, Android expo-share-intent)
      WebShell.tsx               the WebView, safe areas, remount, back button
    web-adapter/
      index.ts                   entry: installs every hook
      fogCache.ts                IndexedDB cache keyed by fingerprint
      receive.ts                 reassembles chunks, verifies SHA-256
      loader.ts                  feeds a File into #zip, reports the outcome from code hooks
      importButtons.ts           "…or a .zip" → native picker; hides the folder picker
      status.ts                  saved-fog line: date, Update, Clear, About; retry panel
      downloads.ts               captures object-URL downloads → export
      links.ts                   window.open / target=_blank → openExternal
      back.ts                    closes the bottom sheet on native "back"
    scripts/build-web.ts         app/ → generated/web.ts (self-contained HTML string)
    test/fixtures/               generator for a synthetic Fog of World backup
    .maestro/                    end-to-end flows
    docs/superpowers/            this spec and the plan
```

### 3.1 Web build (`scripts/build-web.ts`)
- **Input:** `../app/index.html` plus the local stylesheets and scripts it references.
- **Output:** `mobile/generated/web.ts`, which exports `WEB_HTML: string`. `generated/` is gitignored and rebuilt by `prebuild`/`predev` scripts.
- **Transformations**, each covered by a test:
  1. Remove the GoatCounter `<script>` (the only external tag the build is allowed to drop).
  2. Inline every same-origin stylesheet and script.
  3. **Fail the build on any other external script or stylesheet**, naming it.
  4. Inject the adapter as the first script in `<head>`.
  5. Add the Content Security Policy (§3.7), with a SHA-256 hash for each inlined script.
- **Host check:** collect every `http(s)://` host that appears in `app/index.html` and `app/src/*.js`. The build fails, naming the host, if one isn't on either the policy's allowlist or the list of links that are only opened externally. So a new network destination from upstream is always reviewed.
- **Contract check (D5):** load the generated HTML in headless Chromium (Playwright) with the network blocked, import the synthetic fixture through the adapter's loader, and fail unless all of these hold:
  - the elements `#zip`, `#folder`, `#loadStatus`, `#sidebar` and `#brandName` exist;
  - the globals `FogZip.unzip` and `FogParser.FogMap.prototype.addTile` exist;
  - the fixture load reports success with the expected tile count.

### 3.2 Native shell
- `WebShell` renders `<WebView source={{ html: WEB_HTML, baseUrl: "https://crossfog.invalid/" }} />`.
- **Navigation:** only the initial load is allowed. Every other navigation or new window is cancelled, and http(s) URLs go to `Linking.openURL`.
- **User agent:** ends in `CrossTheFog/<version> (+https://madera.codes)`, as the OSM tile policy requires.
- **Safe areas:** edge to edge, with the WebView padded by `react-native-safe-area-context` insets.
- **Reset:** always a remount, by changing the `key` (D15). The same applies after the WebView's content process dies, with the restore guard (§3.5) deciding whether to restore automatically.
- **Android back:** native sends `back`. If the adapter replies `handled: false`, a second press within 2 s exits, and the first shows "Press back again to exit".

### 3.3 Bridge protocol (`src/bridge/protocol.ts`)
Every message is JSON `{ v: 1, type, ...payload }`, and both sides validate it with Zod. A message that fails validation is dropped and logged, never acted on.

| Direction | type | Payload | Effect |
|---|---|---|---|
| web → native | `ready` | — | The page and adapter have loaded |
| web → native | `pickBackup` | — | Open the document picker (from "…or a .zip" or Update) |
| web → native | `needBytes` | `fingerprint` | The cache doesn't have this copy, so stream it |
| web → native | `loaded` | `fingerprint`, `ok`, `tiles` or `reason` (`unzip`, `noTiles`, `memory`, `checksum`, `unknown`) | The outcome of loading a copy |
| web → native | `clearSavedFog` | — | Delete the saved fog (§3.4) |
| web → native | `export` | `filename`, `mime`, `text` | Write a cache file and call `Sharing.shareAsync` |
| web → native | `openExternal` | `url` (http/https only) | `Linking.openURL` |
| web → native | `openAbout` | — | Open the `about` modal |
| web → native | `back:result` | `handled` | If false, apply the double-press exit |
| native → web | `restore` | `fingerprint`, `name`, `savedAt` | Load this copy: from the cache if it holds this fingerprint, otherwise ask with `needBytes` |
| native → web | `chunk` | `fingerprint`, `index`, `total`, `data` (base64 of 1 MB) | One part of a transfer (S2 tunes the size) |
| native → web | `none` | — | No saved fog yet (first run) |
| native → web | `restoreSuspended` | `savedAt` | The guard tripped (§3.5), so show the retry panel |
| native → web | `back` | — | The hardware back button was pressed |

If S5 passes, `restore` gains `kind: "folder"` and each `chunk` carries a file name; the adapter then assigns the files to `#folder`.

### 3.4 Fog store (native, D4)
- **Files** in `Paths.document/fog/`:
  - `current.zip` and `current.json` (`name`, `sha256`, `size`, `savedAt`, `source`: `picker` or `share`)
  - `pending.zip` and `pending.json`, which exist only during an import
- **Fingerprint:** the SHA-256 of the zip, computed once at import.
- **Import** (from the picker or a shared file):
  1. Copy the file to `pending.zip` straight away. Temporary access grants expire, so the original is never read again.
  2. Compute the fingerprint and write `pending.json`.
  3. Remount the WebView. defog merges successive loads, so a clean page is needed.
  4. On `ready`, send `restore` for the pending copy. The cache misses, so the bytes are streamed in chunks.
  5. On `loaded ok`, replace `current.*` with `pending.*` using renames. The adapter has already cached the new copy (§3.6).
  6. On `loaded` not ok, delete `pending.*`, remount, and restore `current`, or send `none` if there isn't one. The adapter says "That file isn't a Fog of World backup. Your saved fog is unchanged."
  7. If a saved fog already exists when a file is shared in, native asks first: "Replace your saved fog with ‹name›?"
- **Launch:** if `current.json` exists, send `restore`; otherwise send `none`.
- **Clear saved fog:** delete `current.*` and `pending.*`, have the adapter clear IndexedDB, then remount.
- **`current.*` is never deleted automatically.** Only a successful import replaces it, and only Clear removes it.
- `store.ts` depends on a small `FileStore` interface. Production uses `expo-file-system`, and tests use an in-memory fake.

### 3.5 Restore guard (`fog/restoreGuard.ts`)
- Before sending `restore`, native writes `restoring.json` (`fingerprint`, `attempts`) and deletes it when `loaded` arrives.
- If the WebView's content process dies (`onContentProcessDidTerminate` on iOS, `onRenderProcessGone` on Android) while that file exists, `attempts` goes up by one and the WebView is remounted.
- After two failed attempts for the same fingerprint, native sends `restoreSuspended` instead of `restore`. The adapter then shows "Your saved fog couldn't be opened. The last attempt ran out of memory." with **Retry**, **Choose another backup** and **Clear saved fog**.

### 3.6 Web adapter
- **Import buttons:** a capture-phase click listener on `#zip` and its label cancels the WebView's own file chooser and sends `pickBackup`. The folder picker's label (`#folder`) is hidden, because folder import exists only through S5.
- **Receive and cache:**
  - Reassembles the chunks and checks the SHA-256 with `crypto.subtle`. On a mismatch it asks for the transfer once more, then reports `checksum`.
  - **Only after a successful load**, writes the copy to IndexedDB (`crossfog` database, keyed by fingerprint) and deletes every other entry. A failed import therefore never displaces the current copy's cache. Writing is best-effort, and failures are ignored.
  - Shows progress ("Loading your fog… 12 / 50 MB") in its own status line.
- **Loader:** builds a `File`, assigns it to `#zip` through a `DataTransfer`, and fires `change`, so defog's own `loadFromZip` does the loading.
- **Outcome from code, not text:** the adapter wraps two globals defined by upstream.
  - `FogZip.unzip`: a thrown `RangeError` is reported as `memory`; any other exception as `unzip`.
  - `FogParser.FogMap.prototype.addTile`: counts the tiles that were added.

  defog inflates and adds tiles synchronously after unzipping, so a task queued when `unzip` returns runs after loading has finished. At that point the count decides between `ok` and `noTiles`. If `unzip` isn't called within 30 s, the outcome is `unknown`. defog's own status text stays on screen.
- **Saved-fog line**, shown under `#loadStatus`: "Saved backup ‹name›, imported ‹date› · Update · Clear saved fog · About". Update sends `pickBackup`. After 7 days the date is highlighted, for example "3 weeks old".
- **Retry panel** (for `restoreSuspended` and failed restores): Retry, Choose another backup, Clear saved fog.
- **Downloads:** `URL.createObjectURL` is wrapped, and clicks on `<a download>` whose URL is known are cancelled and sent as `export`. This covers `route.js` `saveBlob` and `export.js` `download`.
- **Links:** `window.open` and `target=_blank` go through `openExternal`.
- **Back:** closes the bottom sheet if it's open (`handled: true`); otherwise replies `handled: false`.
- **Brand:** `#brandName` becomes `CROSS THE FOG`.

### 3.7 Content Security Policy (D12)
Delivered as a `<meta http-equiv="Content-Security-Policy">` tag. The starting set, finalized by the host check in the plan:
- `default-src 'none'`
- `script-src` with the inlined scripts' SHA-256 hashes, and no `unsafe-eval`
- `style-src 'unsafe-inline'` (defog sets inline styles throughout)
- `img-src data: https://tile.openstreetmap.org https://*.tile-cyclosm.openstreetmap.fr`
- `connect-src https://brouter.de https://overpass-api.de`
- `base-uri 'none'` and `form-action 'none'`

Links opened externally (Google Maps, the Drive and OneDrive help links) are navigations, which native intercepts. They aren't fetches.

### 3.8 Share-to-app (D14)
- **iOS:** `ios.infoPlist.CFBundleDocumentTypes` declares `public.zip-archive` with `LSHandlerRank: Alternate` and `LSSupportsOpeningDocumentsInPlace: false`, so iOS copies the file into the app's Inbox. The file URL arrives through `+native-intent`, which passes it to `import/incoming.ts` and routes to `/`.
- **Android:** `expo-share-intent` with `disableIOS: true` receives shares of `application/zip` and its common aliases.
- **Both platforms:** only files named `*.zip` are accepted. Anything else shows "Cross the Fog can only import .zip backups." Accepted files go through the import flow (§3.4).

### 3.9 About screen
- "Cross the Fog is based on defog by szalapak", with a link and the full MIT notice.
- Leaflet (BSD-2-Clause), pako (MIT), and OpenStreetMap (© OpenStreetMap contributors, ODbL).
- A list of the app's own dependency licenses, generated at build time.
- The app version.

## 4. Store baseline (built into the MVP now)
- **Android:** targets API 36 and runs edge to edge. It declares only `INTERNET`, and location permissions are blocked. The 16 KB page-size check is run on a release build.
- **iOS:** built with Xcode 26. `privacyManifests` declares the required-reason APIs that Expo's Apple privacy guide lists for the modules used. There are no permission usage strings.
- **MVP distribution:** EAS `preview` APKs for Android and local development builds on the owner's iPhone.

## 5. Store-readiness gate (before any submission, not part of the MVP)
- **Written OK from szalapak**, cited in the review notes. MIT already allows the app; this is for reviewers and courtesy.
- **An early review test** through TestFlight and Play internal testing, before investing in store listings. This needs a paid Apple Developer membership.
- **Privacy disclosures:**
  - The backup is the user's location history. It is processed on the device and included in device backups.
  - Route waypoints and map areas are sent to BRouter and Overpass, and tile servers see which areas are viewed.
  - Play's Data Safety form and Apple's App Privacy labels must say so. "No location permission" doesn't mean "no location data".
- **Resilience:**
  - A build-time override for the tile, BRouter and Overpass URLs (a build transform, so `app/` stays untouched).
  - A commercial or self-hosted tile provider.
  - EAS Update for fixes without a store release.
  - Crash reporting.
- **Listing:** say "works with Fog of World data" without implying any affiliation. Run a trademark search for "Cross the Fog", and publish a privacy policy on `madera.codes`.

## 6. Out of the MVP
Location and the "you are here" dot; folder import inside the WebView (`webkitdirectory`); onboarding screens; dark mode; analytics; OTA updates; and any native reimplementation of defog's logic.

## 7. Test build (the plan's first task, throwaway code)
These questions are answered on a real Android device and a real iPhone:

| # | Question | Pass | Fallback if it fails |
|---|---|---|---|
| S1 | Do `localStorage` and IndexedDB work under `https://crossfog.invalid/`, and survive a force-quit and a reinstall-over-update? | The same records are present after both | Display settings reset on every launch and the cache is skipped, so every launch uses the transfer. The fog stays safe (D4). File a follow-up. |
| S2 | With a 50 MB zip, is (a) a cached restore plus load under 10 s, and (b) a chunked transfer plus load under 30 s, on a mid-range Android phone and an iPhone? | Both within limits | (a) Skip the cache and always transfer. (b) Tune the chunk size. If a transfer still takes more than 60 s, stop and revisit the transfer design with the owner. |
| S3 | Does tapping "…or a .zip" open only the native picker? | The WebView's own chooser never appears | Intercept the input's `click` instead of the label's |
| S4 | Does a `.zip` shared from Files, Google Drive and Dropbox reach the import flow? On iOS, does this work through "Open in" without a paid account? | It arrives on both platforms | iOS: expo-share-intent's share extension, which needs an App Group and possibly a paid account. Android: a `VIEW` intent filter only ("Open with"). |
| S5 | Linked Sync folder: can a picked cloud folder (iOS: iCloud Drive; Android: SAF via Dropbox or OneDrive) be re-read after a restart without picking it again? | Tiles load on the next launch without a prompt | The feature is dropped from the MVP on that platform |

If S5 passes on a platform, the MVP gains a **Link Sync folder** action there. It keeps the folder permission and re-reads the folder on each launch. Its fingerprint is a hash of the files' names, sizes and modification times, so an unchanged folder is served from the cache.

## 8. Error handling
- **An imported file isn't a backup:** the pending copy is discarded and the adapter says the saved fog is unchanged. defog's own message stays visible.
- **The saved copy fails to load** (`unzip`, `noTiles`, `checksum`, `unknown`): `current.*` is kept and the retry panel is shown. **Nothing is ever deleted automatically.**
- **The cache can't be written:** ignored, and the next launch transfers again.
- **The content process dies:** the restore guard (§3.5) handles it.
- **The linked folder is unreachable (S5):** show the cached copy if there is one, with "Couldn't reach your Sync folder. Showing fog from ‹date›."
- **An export fails:** a native toast. A cancelled share stays silent.
- **An invalid bridge message:** dropped (§3.3).
- **A shared file isn't a `.zip`:** a toast (§3.8).

## 9. Testing
- **Vitest.** Stryker runs over the same code with a break threshold of 80%.
  - **Adapter** (jsdom with `fake-indexeddb`):
    - cache hit and miss
    - reassembling chunks, and a checksum mismatch leading to one retry and then `checksum`
    - every outcome (`ok` with a count, `unzip`, `memory`, `noTiles`, `unknown`)
    - the import buttons being intercepted and the folder picker hidden
    - the saved-fog line and its 7-day highlight
    - the retry panel
    - back handling
    - download capture for both upstream download functions
    - external links
  - **Native logic** (pure TypeScript with injected fakes):
    - the fog store, including that a failure never touches `current.*`, that pending is promoted only on `ok`, and Clear
    - the restore guard, which trips after two crashes
    - the incoming-file filter
    - the protocol, where every message round-trips and malformed messages are rejected
  - **Build:**
    - GoatCounter is removed
    - an unknown external script fails the build
    - the adapter comes first
    - the policy's hashes match the inlined scripts
    - a new host fails the host check
    - the contract check fails on fixture HTML that's missing an element or a global
- **Synthetic fixture:** `test/fixtures/make-backup.ts` builds a small valid Fog of World zip covering a made-up area, following the tile format in `app/src/parser.js`. **Real Sync data is never committed.**
- **Maestro** on both platforms:
  - import through the picker, then the fog is shown
  - restart, then the fog is restored from the cache
  - a debug-only action clears the cache to simulate eviction; restart, then the fog comes back through the transfer
  - import a file that isn't a backup, then the saved fog is unchanged
  - Export GPX opens the share sheet
  - About shows the defog credit
- **Manual device checklist:**
  - a real multi-MB backup
  - sharing from Files, Drive and Dropbox
  - the linked folder, if built
  - killing the content process mid-restore trips the guard
  - the 16 KB page-size check
  - the UA suffix on a tile request, checked in `chrome://inspect` and Safari Web Inspector
- **Upstream merge procedure:**
  1. Read `git diff HEAD...upstream/main -- app/` before merging, because that code will run next to users' location history.
  2. Merge.
  3. Run the build (contract and host checks) and the tests.
  4. Never resolve a conflict inside `app/`.

## 10. Risks
- **The Fog of World format is reverse-engineered** (through defog's parser). A format change would break imports until upstream updates the parser. Failures show up as `unzip` or `noTiles`, and the saved copy is kept.
- **Store review of a wrapper** (Apple 4.2, Play minimum functionality): native import, sharing and persistence reduce the risk, and the gate (§5) tests it before any submission.
- **Public volunteer servers** (OSM tiles, brouter.de, overpass-api.de) can throttle or block us. That's acceptable for personal MVP use and handled in the gate.

## 11. Revisit at 1.0
- What "traction" means and how it's measured. Analytics are out of the MVP on purpose.
- Crash reporting, EAS Update and a tile provider (§5).
- Whether to keep the wrapper or start a native rewrite, based on what using the MVP revealed.
