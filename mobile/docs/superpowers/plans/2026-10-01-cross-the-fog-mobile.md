# Cross the Fog Mobile App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Cross the Fog, an Expo app for Android and iOS. It runs the unmodified defog web app in a WebView, keeps the user's imported fog in a native file, and adds native import, share-to-app and export.

**Architecture:** `mobile/` is a standalone Expo SDK 57 package. A build script turns `../app/index.html` into one self-contained HTML string, with an injected web adapter and a strict CSP. The native shell loads that string under `https://crossfog.madera.codes/` and talks to the adapter through a Zod-validated message protocol. All logic is pure TypeScript with injected dependencies, tested with Vitest and Stryker. A thin platform layer wires in the Expo modules.

**Tech Stack:**
- Expo SDK 57 (CNG, expo-router), react-native-webview
- expo-file-system, expo-crypto, expo-document-picker, expo-sharing, expo-share-intent
- Zod 4, TypeScript 7, pnpm 11
- Biome, Vitest 5 (jsdom, fake-indexeddb), Stryker 10, knip, lefthook
- Playwright, esbuild, linkedom, fflate, Maestro

**Spec:** `mobile/docs/superpowers/specs/2026-09-30-cross-the-fog-mobile-design.md` (approved). Read it before any task. Section and decision numbers below (§3.4, D11…) refer to it.

## Global Constraints

**Repo, branch and commits**
- Paths are relative to the repo root `/Users/leo/Lab/defog`, except inside `cd mobile` commands.
- Work on branch `cross-the-fog`. The one exception is Task 1's throwaway code.
- Commit after each task. Don't push or open a PR unless the owner asks. If they ask for a PR, use `gh pr create --repo leonardoazeredo/defog --base main`.
- No AI attribution in commits, PRs or code.
- Comments explain why, never what.

**Upstream and native config**
- `app/` is never edited (D3). The only new file outside `mobile/` is the root `lefthook.yml` (Task 2). Never resolve a conflict inside `app/`.
- Expo SDK 57 with Continuous Native Generation (D1):
  - `android/` and `ios/` are never committed.
  - Native config lives only in `mobile/app.config.ts` and config plugins.
- Add Expo modules and react-native-webview with `pnpm exec expo install <pkg>`. Never hand-pin `react`, `react-native` or Expo packages.

**Identity and origin**
- App ID `codes.madera.crossfog` on both platforms (D6).
- Display name `Cross the Fog`, slug `cross-the-fog`, scheme `crossfog`.
- `ORIGIN = "https://crossfog.madera.codes/"` (D11). The app never navigates to it or fetches from it, and nothing is ever deployed there. The only thing that answers for it is the contract check's in-browser request interception (Task 9).

**Permissions and user agent**
- Android declares only `android.permission.INTERNET`.
- `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` and `ACCESS_BACKGROUND_LOCATION` are in `blockedPermissions` (D7).
- iOS has no permission usage strings.
- User agent suffix: `CrossTheFog/<version> (+https://madera.codes)` (§3.2).

**Behaviour and data**
- The WebView is reset only by remounting it (changing its `key`), never with `reload()` (D15).
- Saved fog is never deleted automatically (§3.4). Only a successful import replaces it, and only Clear removes it.
- Real Fog of World data is never committed. Tests use the synthetic fixtures from Task 4.

**Quality and copy**
- Stryker's `break` threshold is 80 (§9).
- Quoted user-facing strings in this plan are exact, including `…` (U+2026), `·`, `✓` and the `‹›` placeholders.

**Toolchain**
- Node ≥ 26 and `pnpm@11.17.0` (`packageManager`), as in the owner's other projects.

## Plan decisions that need the owner's OK

The spec leaves these open, or this plan changes them. Reviewed by the adversarial council (2026-10-01) and approved with the amendments noted in each item. Execution method: owner's choice; see the Execution Handoff at the bottom of this file.

1. **Protocol additions** (§3.3):
   - `retryRestore` (web → native), sent by the retry panel's Retry.
   - `notice { text }` (native → web), for messages that must survive a remount.
   - `size` on `restore`, for progress in MB.
   - `role: "current" | "pending"` on `restore`, so the retry panel appears only for the saved copy.
2. **Fog store layout** (§3.4). Instead of renaming `pending.*` over `current.*`:
   - Zips are stored by content, as `fog/<sha256>.zip`.
   - Numbered pointers (`current-000001.json`, …) name the saved copy.
   - `pending.json` names an import in progress.

   Every step is a create, a rename to a new name or a delete. So a crash at any point leaves the old copy or the new one (RF3).
3. **Restore guard counting** (§3.5):
   - An attempt counts when a restore starts and no `loaded` follows. So a crash of the whole app trips the guard too, not only a WebView process death.
   - A restore interrupted twice in a row (for example, the system killing the app in the background) also shows the retry panel.
   - A pending import found at launch means the app died mid-import. It is discarded, with the import-failed notice.
   - The suspended retry panel has three buttons: "Retry" (`guard.reset()` then remount), "Choose another backup" (opens the picker without restoring), and "Clear saved fog" (clears the store without restoring). These are the escape hatches when the guard trips from OS kills.
4. **Clear asks first, and the cache follows native** (§3.4, §3.6):
   - "Clear saved fog" shows a native confirmation.
   - The adapter empties IndexedDB whenever native sends `none`, instead of emptying it before sending `clearSavedFog`.
5. **Downloads** (§3.6). Upstream's `index.html` doesn't load `export.js`. Capture therefore covers:
   - `route.js` `saveBlob` (GPX and KML).
   - Any `<a download>` whose URL came from `URL.createObjectURL`.

   There's no `export.js` test.
6. **E2E seams**, active only in the `e2e` build:
   - The native picker is replaced by a chooser with two bundled fixtures, "Standard backup" and "Not a backup".
   - The page gets a "Dev: drop fog cache" button (§9's debug-only action).
   - The two synthetic zips (about 1 KB each) are committed in `mobile/assets/e2e/`.
7. **Copy the spec didn't fix:**
   - Failed restore panel: "Your saved fog couldn't be opened."
   - An import that crashed the WebView or couldn't be copied: "That backup couldn't be opened. Your saved fog is unchanged."
   - Export failure toast: "Couldn't share the file."
   - Replace dialog buttons: "Cancel" / "Replace".
   - Clear dialog: title "Clear saved fog?", message "You'll need to import a backup again to see your fog.", buttons "Cancel" / "Clear".
   - Dates look like "12 Sep 2026", with fixed English month abbreviations. Device locales disagree, for example "Sept".
   - From 7 days old, the age follows the date, highlighted:
     - "(1 week old)"
     - "(‹n› weeks old)" under 60 days
     - "(‹n› months old)" from 60 days
   - MB means 1,000,000 bytes. Sizes under 10 MB get one decimal ("2.5"); larger ones are whole numbers ("12").
8. **A file shared during an import** waits until that import finishes. Then it goes through the usual flow, including the replace question.
9. **Version** starts at `0.1.0`.
10. **Root `lefthook.yml`:**
    - Pre-commit: Biome on staged files under `mobile/`.
    - Pre-push: `pnpm verify`.
11. **pako's license** is shown as "MIT and Zlib", as its header says, not "MIT" (§3.9).
12. **Temporary copies are deleted** after an import: the iOS `Inbox` copy, the picker's cache copy and the share cache copy. Only files inside the app's own cache or `Documents/Inbox` are ever deleted.
13. **The picker applies the `.zip` name filter too.** §3.8 names only shares. A picked `notes.txt` gets the same toast.

## Review Focus

- **RF1: re-importing the backup that's already saved.**
  - Expect: the saved fog stays, and its zip isn't deleted, whether the re-import succeeds or fails.
  - Test: Task 10.
- **RF2: double taps and overlapping imports.**
  - Expect: a second `pickBackup` while the picker or an import is running is ignored.
  - Expect: a share arriving mid-import waits, then asks.
  - Test: Task 11.
- **RF3: the app dies at any step of an import, a promotion or a Clear.**
  - Expect: on the next launch the saved fog is the old copy or the new one, intact. Never neither.
  - Test: Task 10.
- **RF4: real backups contain more than tiles** (`__MACOSX/`, `.DS_Store`, other folders).
  - Expect: the tile count is unchanged, and the load reports `ok`.
  - Tests: Tasks 4, 6 and 9.
- **RF5: file names and MIME types vary.**
  - Expect: `Backup.ZIP`, and files shared as `application/octet-stream`, are accepted.
  - Expect: `backup.zip.txt`, `photo.jpg` and names without an extension get "Cross the Fog can only import .zip backups."
  - Test: Task 11.

## File map

(+) marks files added beyond the spec's tree in §3.

```
lefthook.yml                        (+) git hooks for mobile/
mobile/
  package.json  pnpm-workspace.yaml  tsconfig.json  biome.json  knip.json  eas.json
  vitest.config.ts  vitest.contract.config.ts  stryker.config.mjs  metro.config.js
  app.config.ts  .gitignore  README.md
  app/_layout.tsx                   stack, ShareIntentProvider
  app/index.tsx                     renders WebShell
  app/about.tsx                     About modal (§3.9)
  app/+native-intent.ts             file URLs → incoming queue (the spec says .tsx; it has no JSX)
  src/copy.ts                       (+) native user-facing strings
  src/controller.ts                 (+) native orchestration, pure (Task 11)
  src/WebShell.tsx                  WebView, remount, safe areas, back button
  src/ShareIntentBridge.tsx         (+) Android shares → incoming queue
  src/bridge/protocol.ts            ORIGIN, Zod schemas, encode/parse, isTrustedSource
  src/bridge/base64.ts, hex.ts      (+) pure encoders shared with the adapter
  src/bridge/navigationPolicy.ts    (+) allow / block / external
  src/bridge/exportFile.ts          (+) safe export file names, iOS UTIs
  src/bridge/nativeHandlers.ts      share sheet, temp-copy cleanup
  src/fog/fileStore.ts              (+) FileStore interface
  src/fog/store.ts                  fog store (§3.4, decision 2)
  src/fog/restoreGuard.ts           crash-loop breaker (§3.5)
  src/fog/transfer.ts               chunked native → web transfer
  src/import/incoming.ts            name filter, file-URL parsing
  src/import/incomingQueue.ts       (+) holds files that arrive before the shell mounts
  src/import/share-mime.json        (+) MIME types for the picker and Android shares
  src/import/pick.ts                native document picker
  src/platform/expoFileStore.ts     (+) FileStore over expo-file-system
  src/platform/sha256.ts            (+) expo-crypto digest
  src/platform/crashLog.ts          (+) appends timestamped lines to crash.log in documentDirectory
  src/e2e/fixturePicker.ts          (+) e2e-only picker (decision 6)
  web-adapter/                      index, importButtons, links, downloads, back, fogCache,
                                    receive, loader, status, and (+) bridge, session, devTools,
                                    globals.d.ts, tsconfig.json
  scripts/build-web.ts              CLI and buildWebHtml()
  scripts/web/                      (+) hostPolicy, hosts, csp, transform, bundleAdapter, contract
  scripts/contract-check.ts         (+) contract check CLI
  scripts/licenses.ts               (+) writes generated/licenses.json
  scripts/privacy-union.ts          (+) union of the Pods' privacy manifests
  scripts/check-apk.sh              (+) permissions, targetSdk and 16 KB checks
  licenses/                         (+) Leaflet and pako license texts
  assets/e2e/                       (+) standard.zip, not-a-backup.zip
  test/fixtures/                    make-backup.ts, cli.ts
  test/support/                     (+) loadUpstream.ts, memoryFileStore.ts (Node)
  test/adapter/support/             (+) upstreamDom.ts, fakeUpstream.ts (jsdom)
  test/unit/  test/adapter/  test/contract/
  .maestro/                         end-to-end flows
  docs/spike-findings.md  docs/manual-checklist.md
  generated/                        gitignored: web.ts, licenses.json
```

## Task order and the test build

Task 1 needs the owner's phones. Tasks 2–11 don't depend on its findings, so they can run while the owner tests. They use these defaults, which Task 1's findings may change:
- `CACHE_ENABLED = true`
- `CHUNK_BYTES = 1_048_576`
- share MIME list `["application/zip", "application/x-zip-compressed", "application/octet-stream"]`
- the import button is intercepted on both the label and the input

Tasks 12 onwards start only after `mobile/docs/spike-findings.md` is committed.

---

### Task 1: Test build (throwaway) and findings

This task answers §7's S1–S5 on real phones. Its code is never merged. Only the findings document is kept.

**Files:**
- Create on branch `spike/webview-probes`: `spike/` (an Expo app), `spike/build-page.mjs`, `spike/make-big.mjs`
- Create on branch `cross-the-fog`: `mobile/docs/spike-findings.md`

**Interfaces:**
- Consumes: `app/vendor/pako_inflate.min.js`, `app/src/unzip.js`, `app/src/parser.js` (read only).
- Produces: `mobile/docs/spike-findings.md`. It ends with these decision lines, which later tasks read:
  ```
  CACHE_ENABLED: true|false                      S1, S2a → Task 7 web-adapter/index.ts
  CHUNK_BYTES: <bytes>                           S2b     → Task 10 src/fog/transfer.ts
  ZIP_INTERCEPT: label+input|input               S3      → Task 5 importButtons.ts
  SHARE_MIME: [<mime>, …]                        S4      → Task 12 share-mime.json
  IOS_OPEN_IN: pass|fail                         S4      → Task 13
  LINK_FOLDER: ios pass|fail, android pass|fail  S5      → Task 17
  INITIAL_LOAD_URLS: ios […], android […]                → Task 3 decideNavigation
  MESSAGE_SOURCE_URL: ios <url>, android <url>           → Task 3 isTrustedSource
  CRYPTO_SUBTLE: ios yes|no, android yes|no              → Task 7 sha256Hex
  ```

- [ ] **Step 1: Branch and scaffold**

```bash
git switch -c spike/webview-probes
pnpm dlx create-expo-app@latest spike --template blank-typescript@sdk-57 --no-install
cd spike && pnpm install
pnpm exec expo install react-native-webview expo-file-system expo-document-picker expo-crypto expo-dev-client expo-share-intent
pnpm add -D fflate
```

Expected: `pnpm exec expo-doctor` reports no problems.

- [ ] **Step 2: Configure `spike/app.json`**

- Name "Cross the Fog Probe", ID `codes.madera.crossfog.probe` on both platforms, scheme `crossfogprobe`.
- iOS document type from §3.8: `public.zip-archive`, `LSHandlerRank: Alternate`, `LSSupportsOpeningDocumentsInPlace: false`.
- Plugin `["expo-share-intent", { "disableIOS": true, "androidIntentFilters": ["application/zip", "application/x-zip-compressed", "application/octet-stream"] }]`.

- [ ] **Step 3: Write `spike/make-big.mjs` and run it**

It writes `spike/out/big-50mb.zip` with fflate:
- six tiles at x = 256…261, y = 256
- every tile holds all 16,384 blocks, filled from a seeded PRNG
- each tile is zlib level 0
- the zip stores its entries as `Sync/<name>` (same naming as Task 4)

Run: `node make-big.mjs`
Expected: a file of 50–52 MB, and its SHA-256 printed.

- [ ] **Step 4: Build the probe**

`spike/build-page.mjs` writes `spike/page.ts`, which exports the probe page as an HTML string. The page inlines the three upstream files. `App.tsx` renders `<WebView source={{ html, baseUrl: "https://crossfog.madera.codes/" }} />` with a native log panel underneath.

Probes:

- **S1, storage:**
  - On load, the page reads a token from `localStorage` and from IndexedDB. If either is missing, it writes a new random token with the time.
  - The page shows both tokens, `isSecureContext`, `typeof crypto.subtle` and `location.href`.
  - Native logs every `onShouldStartLoadWithRequest` URL (with `isTopFrame`) and every message's `nativeEvent.url`.
- **S2, speed:**
  - Native copies a picked `big-50mb.zip` into the documents directory.
  - "Transfer" streams it to the page as base64 `postMessage` chunks of 256 KB, 1 MB or 4 MB (selectable). The page reassembles the chunks, hashes them with `crypto.subtle`, runs `FogZip.unzip` and defog's tile loop, and stores the bytes in IndexedDB. It reports the milliseconds for each phase.
  - "Cached restore" remounts the WebView. The page reads the bytes from IndexedDB, runs the same loop and reports milliseconds.
- **S3, import button:**
  - The page contains upstream's markup: `<label class="file">…or a .zip <input id="zip" type="file" accept=".zip,application/zip" /></label>`.
  - A capture-phase click listener on the label and the input calls `preventDefault()` and posts `pickBackup`.
  - Native shows the alert "pickBackup received".
- **S4, incoming files:** native lists every incoming file.
  - iOS: `Linking.getInitialURL()` and `url` events.
  - Android: `useShareIntent()` files, with their `mimeType`.
- **S5, linked folder:**
  - "Link folder" calls `Directory.pickDirectoryAsync()` from expo-file-system and saves the returned URI in the documents directory.
  - On every launch with a saved URI, native lists that folder (and `Sync/` inside it), streams every file to the page, and the page reports how many tiles it added.

- [ ] **Step 5: Install release builds on the owner's phones**

Timings from dev builds mean nothing.

```bash
pnpm exec expo run:android --variant release --device
pnpm exec expo run:ios --configuration Release --device
```

iOS signs with the owner's free personal team. For the S2 timings, a mid-range Android phone suffices. For the 16 KB page-alignment check (`check-apk.sh`), at least one Android device must be API 35+ (Pixel 9 or equivalent); an API 35 AVD (Pixel 9 profile in Android Studio) is acceptable if no physical device is available.

- [ ] **Step 6: Hand the owner this checklist, then stop until the results come back**

1. **S1:**
   - Note the token, force-quit and relaunch. The same token shows for both stores.
   - Install the same build over the app (Android: `adb install -r`; iOS: run the build again) and relaunch. The token is still the same.
2. **S2:** copy `big-50mb.zip` to the phone and time each chunk size, on a mid-range Android phone and on an iPhone.
   - Pass (a): a cached restore plus load takes under 10 s.
   - Pass (b): a transfer plus load takes under 30 s.
3. **S3:** tap the label text five times and the input area five times. Only the alert appears; the WebView's own chooser never does.
4. **S4:** share a `.zip` from Files, Google Drive and Dropbox on each platform. On iOS also use "Open in…". Every file shows up in the probe's list. Note every MIME type Android reports.
5. **S5:**
   - Link the Fog of World Sync folder: on iOS from iCloud Drive; on Android from Dropbox or OneDrive through the system picker.
   - Force-quit and relaunch. Tiles appear without a prompt.

- [ ] **Step 7: Turn the results into decisions, using §7's fallbacks**

- **S1** fails: `CACHE_ENABLED: false`, plus a "Follow-ups" note in the findings.
- **S2(a)** fails: `CACHE_ENABLED: false`.
- **S2(b)**: `CHUNK_BYTES` is the fastest size that passed. If no size gets under 60 s, **stop and ask the owner** (§7).
- **S3** fails for the label: `ZIP_INTERCEPT: input`.
- **S4**:
  - `SHARE_MIME` is every MIME type seen, plus the three defaults.
  - If iOS fails, **stop and ask the owner** before Task 13. The fallback, expo-share-intent's share extension, needs an App Group and may need a paid account.
- **S5**: record a result per platform in `LINK_FOLDER`.
- **URLs**: copy the initial-load URLs and the message source URLs into the decision lines exactly as logged.
- **`crypto.subtle`**: if it's missing anywhere, Task 7 uses `@noble/hashes` there instead.

- [ ] **Step 8: Commit the findings on `cross-the-fog`**

Write `mobile/docs/spike-findings.md`:
- the devices and OS versions
- the raw numbers
- the decision lines from **Produces**

```bash
git add spike ':(exclude)spike/out' && git commit -m "spike: WebView probes for S1-S5"   # still on spike/webview-probes
git switch cross-the-fog
git add mobile/docs/spike-findings.md
git commit -m "docs(mobile): record test build findings"
```

The spike branch stays local and is never merged.

---

### Task 2: Scaffold `mobile/` and the toolchain

**Files:**
- Create in `mobile/`:
  - `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `biome.json`, `knip.json`, `.gitignore`
  - `vitest.config.ts`, `vitest.contract.config.ts`, `stryker.config.mjs`
  - `app.config.ts`, `app/_layout.tsx`, `app/index.tsx`
  - `web-adapter/tsconfig.json`, `test/adapter/tsconfig.json`
- Create at the repo root: `lefthook.yml`
- Copy from (read only), in `/Users/leo/Lab/chase-cashew/`: `biome.json`, `stryker.config.mjs`, `pnpm-workspace.yaml`, `lefthook.yml`, `apps/mobile/tsconfig.json`

**Interfaces:**
- Produces the package scripts that later tasks extend:
  - `typecheck`: `tsc --noEmit && tsc --noEmit -p web-adapter && tsc --noEmit -p test/adapter`
  - `lint`: `biome check .`
  - `test`: `vitest run --project unit --project adapter`
  - `verify`: `pnpm typecheck && pnpm lint && pnpm test`. Task 9 adds `pnpm test:contract && pnpm build:web`, and Task 16 adds `pnpm knip`.
- Produces two Vitest projects (`passWithNoTests: true`):
  - `unit`: node environment, `test/unit/**/*.test.ts`
  - `adapter`: jsdom environment, `test/adapter/**/*.test.ts`, setup file `fake-indexeddb/auto`
- `vitest.contract.config.ts` runs `test/contract/**/*.test.ts` with a 180 s timeout.

- [ ] **Step 1: Scaffold into a temporary folder and copy it in**

```bash
pnpm dlx create-expo-app@latest "$TMPDIR/ctf" --template blank-typescript@sdk-57 --no-install
rsync -a --exclude .git --exclude node_modules "$TMPDIR/ctf/" mobile/
rm mobile/App.tsx mobile/index.ts mobile/app.json
```

Keep the template's `icon`, `splash` and `android.adaptiveIcon` settings from `app.json`; they move into `app.config.ts` in Step 3.

- [ ] **Step 2: Set up the package and install dependencies**

In `package.json`:
- name `cross-the-fog`, version `0.1.0`, `private: true`
- `main: "expo-router/entry"`
- `packageManager: "pnpm@11.17.0"`
- `engines.node: ">=26"`

Copy chase-cashew's `pnpm-workspace.yaml` settings: `minimumReleaseAge: 1440`, `trustPolicy: no-downgrade`, and `allowBuilds` for esbuild and lefthook. Then:

```bash
cd mobile
pnpm install
pnpm exec expo install expo-router expo-linking expo-constants expo-status-bar react-native-safe-area-context react-native-screens
pnpm add zod@^4.3.0
# Pin to the minimum Zod 4.x patch that shipped z.config({ jitless: true }). Check the Zod
# CHANGELOG when running this; if a later patch is available, pin to it with "=4.x.y" in
# package.json to avoid a CSP-breaking new Function() call under the strict adapter CSP.
pnpm add -D typescript@~7.0.2 @types/node @biomejs/biome vitest@^5 jsdom fake-indexeddb \
  @stryker-mutator/core@^10 @stryker-mutator/vitest-runner@^10 @stryker-mutator/api@^10 \
  knip lefthook tsx esbuild linkedom playwright fflate
```

- [ ] **Step 3: Write the configs**

- **`tsconfig.json`:**
  - Extends `expo/tsconfig.base`.
  - Flags: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
  - Includes `app`, `src`, `scripts`, `test/unit`, `test/contract`, `test/support`, `test/fixtures`, `.expo/types/**/*.ts`, `expo-env.d.ts`.
  - Excludes `web-adapter` and `test/adapter`.
- **`web-adapter/tsconfig.json`:**
  - The same strict flags, with `lib: ["ES2023", "DOM", "DOM.Iterable"]` and `types: []`.
  - Includes `.` and `../src/bridge`.
- **`test/adapter/tsconfig.json`:** extends the adapter's config, adds `types: ["node"]`, and includes `.`, `../fixtures` and `../../web-adapter`.
- **`biome.json`:** chase-cashew's file unchanged.
- **`stryker.config.mjs`:** chase-cashew's file, keeping its workaround comments (`plugins`, `tsconfigFile: "tsconfig.unused-by-stryker.json"`, `coverageAnalysis: "perTest"`). Then set:
  - `thresholds: { high: 90, low: 80, break: 80 }`
  - `mutate`:
    - `src/bridge/{protocol,base64,hex,navigationPolicy,exportFile}.ts`
    - `src/fog/*.ts`
    - `src/import/{incoming,incomingQueue}.ts`
    - `src/controller.ts`
    - `web-adapter/*.ts`, excluding `web-adapter/index.ts` and `web-adapter/globals.d.ts`
    - `scripts/web/{hostPolicy,hosts,csp,transform}.ts`
- **`knip.json`:**
  - Entries: `app/**/*.{ts,tsx}`, `scripts/*.ts`, `web-adapter/index.ts`, `test/**/*.ts`.
  - Project: `src/**`, `web-adapter/**`, `scripts/**`, `test/**`.
  - Ignore: `generated/**`.
- **`.gitignore`:** add `/android`, `/ios`, `generated/`, `test/fixtures/out/`, `reports/`, `.stryker-tmp/`.
- **`app.config.ts`:** with the template's icon and splash entries added:

```ts
import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Cross the Fog",
  slug: "cross-the-fog",
  version: "0.1.0",
  scheme: "crossfog",
  userInterfaceStyle: "light",
  ios: { bundleIdentifier: "codes.madera.crossfog" },
  android: {
    package: "codes.madera.crossfog",
    permissions: [],
    blockedPermissions: [
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
    ],
    // Keeps the hardware back press reaching JS, as in chase-cashew.
    predictiveBackGestureEnabled: false,
  },
  plugins: ["expo-router"],
  experiments: { typedRoutes: true },
});
```

- **Placeholder routes:** `app/_layout.tsx` is `<Stack screenOptions={{ headerShown: false }} />`; `app/index.tsx` renders the text "Cross the Fog".
- **Root `lefthook.yml`:**

```yaml
pre-commit:
  commands:
    biome:
      root: "mobile/"
      glob: "*.{ts,tsx,js,mjs,cjs,json}"
      run: pnpm exec biome check --write --no-errors-on-unmatched {staged_files}
      stage_fixed: true
pre-push:
  commands:
    verify:
      root: "mobile/"
      run: pnpm verify
```

- [ ] **Step 4: Verify**

```bash
cd mobile
pnpm exec expo-doctor        # Expected: no problems
pnpm verify                  # Expected: exit 0
pnpm exec expo prebuild --no-install && git status --short
# Expected: android/ and ios/ are not listed
rm -rf android ios
```

- [ ] **Step 5: Commit**

On commit, lefthook runs Biome on the staged files, and the "No config files with names lefthook" notice no longer appears.

```bash
git add lefthook.yml mobile
git commit -m "chore(mobile): scaffold Expo SDK 57 app and toolchain"
```

---

### Task 3: Bridge protocol and navigation policy

**Files:**
- Create: `mobile/src/bridge/protocol.ts`, `base64.ts`, `hex.ts`, `navigationPolicy.ts`
- Test: `mobile/test/unit/bridge/protocol.test.ts`, `base64.test.ts`, `hex.test.ts`, `navigationPolicy.test.ts`

**Interfaces:**
- Consumes: the findings' `INITIAL_LOAD_URLS` and `MESSAGE_SOURCE_URL`, if Task 1 is already done.
- Produces (protocol types are `z.infer` of the schemas):

```ts
// protocol.ts
export const ORIGIN = "https://crossfog.madera.codes/";
export type LoadFailure = "unzip" | "noTiles" | "memory" | "checksum" | "unknown";
export type CopyRole = "current" | "pending";
export type WebToNative =
  | { v: 1; type: "ready" }
  | { v: 1; type: "pickBackup" }
  | { v: 1; type: "needBytes"; fingerprint: string }
  | { v: 1; type: "loaded"; fingerprint: string; ok: true; tiles: number }
  | { v: 1; type: "loaded"; fingerprint: string; ok: false; reason: LoadFailure }
  | { v: 1; type: "clearSavedFog" }
  | { v: 1; type: "retryRestore" }
  | { v: 1; type: "export"; filename: string; mime: string; text: string }
  | { v: 1; type: "openExternal"; url: string }
  | { v: 1; type: "openAbout" }
  | { v: 1; type: "back:result"; handled: boolean };
export type NativeToWeb =
  | { v: 1; type: "restore"; fingerprint: string; name: string; savedAt: string; size: number; role: CopyRole }
  | { v: 1; type: "chunk"; fingerprint: string; index: number; total: number; data: string }
  | { v: 1; type: "none" }
  | { v: 1; type: "restoreSuspended"; savedAt: string }
  | { v: 1; type: "notice"; text: string }
  | { v: 1; type: "back" };
export type ChunkMessage = Extract<NativeToWeb, { type: "chunk" }>;
export function encode(msg: WebToNative | NativeToWeb): string;
export function parseWebToNative(raw: string): WebToNative | null;
export function parseNativeToWeb(raw: string): NativeToWeb | null;
export function isTrustedSource(url: string): boolean;
// base64.ts
export function encodeBase64(bytes: Uint8Array): string;
export function decodeBase64(text: string): Uint8Array; // throws on invalid input
// hex.ts
export function toHex(bytes: ArrayBuffer | Uint8Array): string; // lowercase
// navigationPolicy.ts
export type NavigationDecision = "allow" | "block" | "external";
export function decideNavigation(url: string, initialLoadDone: boolean): NavigationDecision;
```

Validation rules:

| Field | Rule |
|---|---|
| `v` | literal `1` |
| `fingerprint` | `/^[0-9a-f]{64}$/` |
| `name`, `filename` | 1–255 characters |
| `savedAt` | ISO 8601 date-time |
| `size` | integer ≥ 0 |
| `tiles` | integer ≥ 1 |
| `total` | integer ≥ 1 |
| `index` | integer, 0 ≤ `index` < `total` |
| `data` | `/^[A-Za-z0-9+/]*={0,2}$/` |
| `mime` | 1–100 characters |
| `url` (`openExternal`) | `http:` or `https:` only |
| `text` (`notice`) | 1–500 characters |
| `handled` | boolean |

- [ ] **Step 1: Write the failing tests**

```ts
// protocol.test.ts
const fp = "a".repeat(64);
// webSamples / nativeSamples: one valid message of every type, including both `loaded` shapes
it("round-trips every message", () => {
  for (const m of webSamples) expect(parseWebToNative(encode(m))).toEqual(m);
  for (const m of nativeSamples) expect(parseNativeToWeb(encode(m))).toEqual(m);
});
it.each([
  ["not JSON", "{"],
  ["another version", JSON.stringify({ v: 2, type: "ready" })],
  ["an unknown type", JSON.stringify({ v: 1, type: "selfDestruct" })],
  ["a short fingerprint", JSON.stringify({ v: 1, type: "needBytes", fingerprint: "abc" })],
  ["an uppercase fingerprint", JSON.stringify({ v: 1, type: "needBytes", fingerprint: "A".repeat(64) })],
  ["ok without tiles", JSON.stringify({ v: 1, type: "loaded", fingerprint: fp, ok: true })],
  ["a failure without a reason", JSON.stringify({ v: 1, type: "loaded", fingerprint: fp, ok: false })],
  ["an unknown reason", JSON.stringify({ v: 1, type: "loaded", fingerprint: fp, ok: false, reason: "cosmic" })],
  ["a javascript: link", JSON.stringify({ v: 1, type: "openExternal", url: "javascript:alert(1)" })],
  ["an intent: link", JSON.stringify({ v: 1, type: "openExternal", url: "intent://scan#Intent;end" })],
  ["a file: link", JSON.stringify({ v: 1, type: "openExternal", url: "file:///etc/hosts" })],
])("drops %s from the page", (_, raw) => expect(parseWebToNative(raw)).toBeNull());
it.each([
  ["index equal to total", { v: 1, type: "chunk", fingerprint: fp, index: 2, total: 2, data: "" }],
  ["zero total", { v: 1, type: "chunk", fingerprint: fp, index: 0, total: 0, data: "" }],
  ["non-base64 data", { v: 1, type: "chunk", fingerprint: fp, index: 0, total: 1, data: "@@" }],
  ["a negative size", { v: 1, type: "restore", fingerprint: fp, name: "a.zip", savedAt: "2026-10-01T09:00:00.000Z", size: -1, role: "current" }],
  ["a vague date", { v: 1, type: "restoreSuspended", savedAt: "yesterday" }],
  ["an empty notice", { v: 1, type: "notice", text: "" }],
  ["a long notice", { v: 1, type: "notice", text: "x".repeat(501) }],
])("drops %s from native", (_, msg) => expect(parseNativeToWeb(JSON.stringify(msg))).toBeNull());
it("trusts only the page at ORIGIN", () => {
  expect(isTrustedSource(ORIGIN)).toBe(true);
  expect(isTrustedSource(`${ORIGIN}#plan`)).toBe(true);
  expect(isTrustedSource("https://crossfog.madera.codes/other")).toBe(false);
  expect(isTrustedSource("https://crossfog.madera.codes.evil.example/")).toBe(false);
  expect(isTrustedSource("http://crossfog.madera.codes/")).toBe(false);
  expect(isTrustedSource("about:blank")).toBe(false);
});

// base64.test.ts
it.each([[[0, 1, 2], "AAEC"], [[77, 97, 110], "TWFu"], [[77, 97], "TWE="], [[77], "TQ=="], [[], ""]])(
  "encodes %j", (bytes, text) => {
    expect(encodeBase64(new Uint8Array(bytes))).toBe(text);
    expect([...decodeBase64(text)]).toEqual(bytes);
  });
it("matches Node for random bytes", () => {
  const bytes = randomBytes(1000);
  expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  expect(decodeBase64(encodeBase64(bytes))).toEqual(new Uint8Array(bytes));
});
it("rejects invalid text", () => expect(() => decodeBase64("@@@@")).toThrow());

// hex.test.ts
it("writes lowercase hex", () => {
  expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  expect(toHex(new Uint8Array([171]).buffer)).toBe("ab");
});

// navigationPolicy.test.ts
it.each([
  ["about:blank", false, "allow"],
  [ORIGIN, false, "allow"],
  [ORIGIN, true, "block"],
  ["about:blank", true, "block"],
  ["https://crossfog.madera.codes/other", false, "block"],
  ["https://www.google.com/maps/dir/?api=1", true, "external"],
  ["http://example.org/", true, "external"],
  ["blob:https://crossfog.madera.codes/1234", true, "block"],
  ["intent://scan#Intent;end", true, "block"],
  ["file:///etc/hosts", false, "block"],
  ["data:text/html,hi", false, "block"],
])("%s (initial load done: %s) → %s", (url, done, decision) =>
  expect(decideNavigation(url, done)).toBe(decision));
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm exec vitest run --project unit test/unit/bridge`
Expected: FAIL, because the modules don't exist yet.

- [ ] **Step 3: Implement**

- `isTrustedSource` and `decideNavigation` compare strings and don't use `URL`, because Hermes only partly supports `URL`.
  - `isTrustedSource(url)` receives `event.nativeEvent.url` from React Native WebView's `onMessage` callback — react-native-webview does not expose `event.origin`. Returns `true` only if `url` is `ORIGIN` exactly or starts with `ORIGIN` followed immediately by `#` or `?`.
  - A trusted URL is `ORIGIN` exactly, or `ORIGIN` followed by `#` or `?`.
  - Anything starting with `https://crossfog.madera.codes/` other than the initial load is blocked.
  - If `MESSAGE_SOURCE_URL` from the spike differs from `ORIGIN` on either platform, add that URL as an additional trusted value and note which platform reports it.
- The parse functions run `JSON.parse` inside try/catch, then `safeParse`. Any failure returns `null`.
- If the findings show a different initial-load or message-source URL on a platform, add it here with a comment saying which platform reports it.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `cd mobile && pnpm exec vitest run --project unit test/unit/bridge`
Expected: PASS

- [ ] **Step 5: Mutation check**

Run: `cd mobile && pnpm exec stryker run --mutate "src/bridge/{protocol,base64,hex,navigationPolicy}.ts"`
Expected: exit 0 (score ≥ 80)

- [ ] **Step 6: Commit**

```bash
git add mobile/src/bridge mobile/test/unit/bridge
git commit -m "feat(mobile): bridge protocol, encoders and navigation policy"
```

---

### Task 4: Synthetic Fog of World fixtures

**Files:**
- Create: `mobile/test/fixtures/make-backup.ts`, `mobile/test/fixtures/cli.ts`, `mobile/test/support/loadUpstream.ts`
- Modify: `mobile/package.json` (add the script `fixture`: `tsx test/fixtures/cli.ts`)
- Test: `mobile/test/unit/fixtures.test.ts`

**Interfaces:**
- Consumes: `app/src/unzip.js` and `app/src/parser.js` (read only).
- Produces:

```ts
// make-backup.ts
export interface BlockSpec { bx: number; by: number; fill: number } // every bitmap byte = fill
export interface TileSpec { x: number; y: number; blocks: BlockSpec[] }
export function tileFilename(x: number, y: number): string; // "test" + digits of y*512+x mapped through "olhwjsktri" + "zz"
export function encodeTile(spec: TileSpec): Uint8Array;     // zlib of the decompressed tile
export function makeBackup(tiles: TileSpec[], extras?: Record<string, Uint8Array>): Uint8Array;
export const STANDARD_TILES: TileSpec[];
export const STANDARD_EXTRAS: Record<string, Uint8Array>;
export const STANDARD_TILE_COUNT = 2;
export function standardBackup(): Uint8Array;  // STANDARD_TILES plus STANDARD_EXTRAS
export function notABackup(): Uint8Array;      // a valid zip holding only notes.txt
export function largeBackup(targetBytes: number, seed?: number): Uint8Array;
// test/support/loadUpstream.ts
export interface UpstreamFogMap {
  tileCount: number;
  addTile(name: string, data: Uint8Array): boolean;
  isVisitedCell(cx: number, cy: number): boolean;
}
export function loadUpstream(): {
  unzip(zip: Uint8Array): Array<{ name: string; data: Uint8Array }>;
  newFogMap(): UpstreamFogMap;
  parseTileId(name: string): number | null;
};
export function loadZipLikeDefog(zip: Uint8Array): { tiles: number; fogMap: UpstreamFogMap };
```

**The values these must use:**
- **Decompressed tile** (from `app/src/parser.js`):
  - A header of 128 × 128 little-endian uint16. Entry `by * 128 + bx` holds the 1-based block index; 0 means absent.
  - Then each block: 512 bitmap bytes followed by 3 zero bytes.
- **Zip entries:**
  - Tiles are stored as `Sync/<tileFilename>`, uncompressed (method 0).
  - Every entry's `mtime` is `2026-01-01T00:00:00Z`, so the same input always gives the same bytes. Task 16 relies on this.
- **`STANDARD_TILES`:** tiles (256, 256) and (257, 256). Each has blocks (0,0), (1,0), (0,1) and (1,1), with `fill` 0xff.
- **`STANDARD_EXTRAS`:** three entries, each containing the UTF-8 bytes of "not a tile":
  - `__MACOSX/Sync/._testlwlwhizz`
  - `Sync/.DS_Store`
  - `Fog of World/Settings.plist`
- **`largeBackup`:**
  - Adds random full blocks (seeded mulberry32), filling up to 16,384 blocks per tile, until the zip reaches `targetBytes`.
  - Tile zlib uses level 0, so the size can be predicted.
- **`loadUpstream`:**
  - Runs both upstream files in a `node:vm` context. The context provides `window`, `TextDecoder`, and a `pako` shim built on fflate (`inflateRaw` uses `inflateSync`; `inflate` uses `unzlibSync`).
- **`loadZipLikeDefog`:**
  - Copies `loadFromZip` in `app/src/main.js`: base name = `name.split(/[\\/]/).pop()`, then `try { if (fogMap.addTile(base, pako.inflate(data))) tiles++ } catch {}`.

- [ ] **Step 1: Write the failing tests**

```ts
const up = loadUpstream();
it("names tiles the way the parser reads them", () => {
  expect(tileFilename(257, 256)).toBe("testlwlwhizz");
  expect(up.parseTileId(tileFilename(257, 256))).toBe(131329);
  expect(up.parseTileId(tileFilename(256, 256))).toBe(131328);
});
it("RF4: the standard backup loads two tiles despite its extra entries", () => {
  expect(up.unzip(standardBackup())).toHaveLength(5);
  const { tiles, fogMap } = loadZipLikeDefog(standardBackup());
  expect(tiles).toBe(STANDARD_TILE_COUNT);
  expect(fogMap.isVisitedCell(256 * 8192, 256 * 8192)).toBe(true);
  expect(fogMap.isVisitedCell(256 * 8192 + 127, 256 * 8192 + 127)).toBe(true);
  expect(fogMap.isVisitedCell(256 * 8192 + 128, 256 * 8192)).toBe(false);
});
it("not-a-backup unzips but holds no tiles", () => expect(loadZipLikeDefog(notABackup()).tiles).toBe(0));
it("is deterministic", () => expect(standardBackup()).toEqual(standardBackup()));
it("builds a large backup of about the requested size", () => {
  const zip = largeBackup(5_000_000, 7);
  expect(zip.length).toBeGreaterThanOrEqual(5_000_000);
  expect(zip.length).toBeLessThan(5_100_000);
  expect(loadZipLikeDefog(zip).tiles).toBeGreaterThan(0);
  expect(largeBackup(5_000_000, 7)).toEqual(zip);
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm exec vitest run --project unit test/unit/fixtures.test.ts`
Expected: FAIL, because the modules don't exist yet.

- [ ] **Step 3: Implement `make-backup.ts` and `loadUpstream.ts`**

- [ ] **Step 4: Run the tests and check that they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Write `cli.ts` and run it**

`cli.ts` writes these files to `test/fixtures/out/`:
- `standard.zip`
- `not-a-backup.zip`
- `large-50mb.zip` (`largeBackup(50_000_000)`)

Run: `cd mobile && pnpm fixture`
Expected: the three file names are printed with their sizes, and the large one is just over 50,000,000 bytes.

- [ ] **Step 6: Commit**

```bash
git add mobile/test/fixtures mobile/test/support/loadUpstream.ts mobile/test/unit/fixtures.test.ts mobile/package.json
git commit -m "test(mobile): synthetic Fog of World backup fixtures"
```

---

### Task 5: Adapter page hooks

**Files:**
- Create in `mobile/web-adapter/`: `bridge.ts`, `importButtons.ts`, `links.ts`, `downloads.ts`, `back.ts`, `globals.d.ts`
- Create: `mobile/test/adapter/support/upstreamDom.ts`
- Test: `mobile/test/adapter/hooks.test.ts`

**Interfaces:**
- Consumes:
  - From Task 3: `WebToNative`, `NativeToWeb`, `encode`, `parseNativeToWeb`.
  - From Task 1, if available: `ZIP_INTERCEPT`.
- Produces:

```ts
// bridge.ts
export type Send = (msg: WebToNative) => void;
export function createSend(win: Window): Send;
export function onNativeMessage(win: Window, doc: Document, handler: (msg: NativeToWeb) => void): () => void;
// importButtons.ts
export function installImportButtons(doc: Document, send: Send): void;
// links.ts
export function installLinks(win: Window, doc: Document, send: Send): void;
// downloads.ts
export function installDownloads(win: Window, doc: Document, send: Send): void;
// back.ts
export function handleBack(doc: Document): boolean; // true when it closed the bottom sheet
// test/adapter/support/upstreamDom.ts
export function loadUpstreamDom(doc: Document): void; // the <body> of app/index.html, without running scripts
```

`globals.d.ts` declares:
- `Window.ReactNativeWebView?: { postMessage(data: string): void }`
- the parts of `FogZip` and `FogParser` that the adapter touches
- `declare const __CROSSFOG_DEV_TOOLS__: boolean`

**Behaviour** (§3.6):
- **`createSend`** posts `encode(msg)` through `win.ReactNativeWebView`. When that's missing, it logs a warning and does nothing.
- **`onNativeMessage`:**
  - Listens for `message` on both `win` and `doc`, because iOS dispatches on `window` and Android on `document`.
  - Handles each event object once, tracked in a `WeakSet`.
  - Drops data that fails `parseNativeToWeb`, with `console.warn("crossfog: dropped invalid message")`.
  - Returns an unsubscribe function.
- **`installImportButtons`:**
  - Adds a capture-phase `click` listener on `doc`. When the target is `#zip` or inside its `<label>`, it calls `preventDefault()` and `stopPropagation()` and sends `pickBackup`.
  - With `ZIP_INTERCEPT: input`, it reacts only to the input itself.
  - It hides `#folder`'s label with `style.display = "none"`.
- **`installLinks`:**
  - Replaces `win.open` with a function that sends `openExternal` for http(s) URLs and returns `null`.
  - A capture-phase click on an `a[target="_blank"]` with an http(s) `href` calls `preventDefault()` and sends `openExternal`.
- **`installDownloads`:**
  - Wraps `win.URL.createObjectURL` so it remembers `url → Blob` for `Blob` arguments.
  - A capture-phase click on an `a[download]` with a remembered `href` calls `preventDefault()` and sends `export { filename: a.download, mime: blob.type, text: await blob.text() }`.
- **`handleBack`:** if `#sidebar` has the class `open`, removes it (as `app/src/main.js` does) and returns true. Otherwise returns false.

- [ ] **Step 1: Write the failing tests**

`beforeEach`:
- `loadUpstreamDom(document)`
- `sent = []` with `send = (m) => sent.push(m)`
- jsdom has no `URL.createObjectURL`, so stub it (`URL.createObjectURL = vi.fn(() => \`blob:test/${n++}\`)`) before `installDownloads`

```ts
const click = (el: Element) => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
};
it("“…or a .zip” opens the native picker instead of the WebView's chooser", () => {
  installImportButtons(document, send);
  expect(click(document.getElementById("zip")!.closest("label")!).defaultPrevented).toBe(true);
  expect(click(document.getElementById("zip")!).defaultPrevented).toBe(true);
  expect(sent).toEqual([{ v: 1, type: "pickBackup" }, { v: 1, type: "pickBackup" }]);
});
it("hides the folder picker", () => {
  installImportButtons(document, send);
  expect(document.getElementById("folder")!.closest("label")!.style.display).toBe("none");
});
it("leaves other clicks alone", () => {
  installImportButtons(document, send);
  expect(click(document.getElementById("tabPlan")!).defaultPrevented).toBe(false);
  expect(sent).toEqual([]);
});
it("window.open sends openExternal and returns null", () => {
  installLinks(window, document, send);
  expect(window.open("https://www.google.com/maps/dir/?api=1", "_blank", "noopener")).toBeNull();
  expect(sent).toEqual([{ v: 1, type: "openExternal", url: "https://www.google.com/maps/dir/?api=1" }]);
});
it("help links open outside the app", () => {
  installLinks(window, document, send);
  expect(click(document.querySelector('a[href="https://drive.google.com"]')!).defaultPrevented).toBe(true);
  expect(sent).toEqual([{ v: 1, type: "openExternal", url: "https://drive.google.com/" }]);
});
it.each([
  ["fogtomaps-route.gpx", "application/gpx+xml"],
  ["fogtomaps-route.kml", "application/vnd.google-earth.kml+xml"],
])("captures route.js saveBlob for %s", async (filename, mime) => {
  installDownloads(window, document, send);
  const a = document.createElement("a"); // the same steps as saveBlob in app/src/route.js
  a.href = URL.createObjectURL(new Blob(["<route/>"], { type: mime }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  await vi.waitFor(() => expect(sent).toEqual([{ v: 1, type: "export", filename, mime, text: "<route/>" }]));
});
it("back closes the open sheet and says so", () => {
  const sidebar = document.getElementById("sidebar")!;
  sidebar.classList.add("open");
  expect(handleBack(document)).toBe(true);
  expect(sidebar.classList.contains("open")).toBe(false);
  expect(handleBack(document)).toBe(false);
});
it("handles a message once even when window and document both see it", () => {
  const got: unknown[] = [];
  onNativeMessage(window, document, (m) => got.push(m));
  document.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ v: 1, type: "none" }), bubbles: true }));
  expect(got).toEqual([{ v: 1, type: "none" }]);
});
it("drops invalid messages", () => {
  const got: unknown[] = [];
  onNativeMessage(window, document, (m) => got.push(m));
  window.dispatchEvent(new MessageEvent("message", { data: '{"v":1,"type":"selfDestruct"}' }));
  expect(got).toEqual([]);
});
```

The help-link URL is the anchor's `href` property, which the browser normalizes with a trailing `/`.

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm exec vitest run --project adapter test/adapter/hooks.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the five modules and `globals.d.ts`**

If jsdom's `Blob` lacks `text()`, polyfill it in the test file with `FileReader`.

- [ ] **Step 4: Run the tests and check that they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Mutation check**

Run: `cd mobile && pnpm exec stryker run --mutate "web-adapter/{bridge,importButtons,links,downloads,back}.ts"`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add mobile/web-adapter mobile/test/adapter
git commit -m "feat(mobile): web adapter hooks for import, links, downloads and back"
```

---

### Task 6: Adapter load pipeline

**Files:**
- Create in `mobile/web-adapter/`: `fogCache.ts`, `receive.ts`, `loader.ts`
- Create: `mobile/test/adapter/support/fakeUpstream.ts`
- Test in `mobile/test/adapter/`: `fogCache.test.ts`, `receive.test.ts`, `loader.test.ts`

**Interfaces:**
- Consumes:
  - From Task 3: `ChunkMessage`, `decodeBase64`.
  - From Task 4: the fixtures.
- Produces:

```ts
// fogCache.ts: IndexedDB database "crossfog", version 1, object store "copies", key = fingerprint
export interface FogCache {
  get(fingerprint: string): Promise<Uint8Array | null>;
  putOnly(fingerprint: string, bytes: Uint8Array): Promise<void>; // stores it and deletes every other entry
  clearAll(): Promise<void>;
}
export function openFogCache(idb: IDBFactory | undefined, enabled: boolean): Promise<FogCache>;
// receive.ts
export type ReceiveResult =
  | { kind: "partial"; receivedBytes: number }
  | { kind: "complete"; bytes: Uint8Array }
  | { kind: "mismatch" };
export function createReceiver(
  fingerprint: string,
  sha256Hex: (bytes: Uint8Array) => Promise<string>,
): { accept(chunk: ChunkMessage): Promise<ReceiveResult> };
// loader.ts
export type LoadOutcome = { ok: true; tiles: number } | { ok: false; reason: "unzip" | "noTiles" | "memory" | "unknown" };
export interface OutcomeHooks { arm(): Promise<LoadOutcome> } // settles for the next unzip call
export function installOutcomeHooks(win: Window, timeoutMs?: number): OutcomeHooks; // default 30_000
export type AssignFiles = (input: HTMLInputElement, file: File) => void;
export const assignFilesWithDataTransfer: AssignFiles;
export function loadCopy(
  bytes: Uint8Array,
  name: string,
  deps: { zipInput: HTMLInputElement; hooks: OutcomeHooks; assignFiles: AssignFiles },
): Promise<LoadOutcome>;
// test/adapter/support/fakeUpstream.ts
export function installFakeUpstream(win: Window, doc: Document): void;
```

**Behaviour:**
- **`openFogCache`:**
  - Never rejects.
  - When `enabled` is false, `idb` is missing or IndexedDB fails, `get` returns `null` and the other methods resolve without doing anything.
- **Receiver:**
  - Chunks are kept by `index`, so a duplicate chunk changes nothing.
  - When all `total` chunks have arrived, it hashes the bytes and returns `complete`, or `mismatch` if the hash isn't the fingerprint.
- **`installOutcomeHooks`:**
  - Throws `"adapter contract: FogZip.unzip missing"` or `"adapter contract: FogParser.FogMap.prototype.addTile missing"` when a global is missing.
  - Otherwise it wraps both functions. The algorithm (§3.6):

```
arm():  create promise P; start a timer (timeoutMs) that settles P with { ok: false, reason: "unknown" }
addTile wrapper: r = original.apply(this, args); if (r) added++; return r
unzip wrapper:   if not armed → return original(buf)
                 start = added
                 try { entries = original(buf) }
                 catch (e) { settle(e instanceof RangeError ? memory : unzip); throw e }
                 setTimeout(0): n = added - start; settle(n > 0 ? { ok: true, tiles: n } : noTiles)
                 return entries
settle: clear the timer, disarm, resolve P once
```

  defog inflates and adds the tiles synchronously after `unzip` returns. So the zero-delay timer runs after the whole load, and the counted difference covers only this load, even though defog merges loads.
- **`loadCopy`:**
  1. `p = hooks.arm()`
  2. `assignFiles(zipInput, new File([bytes], name, { type: "application/zip" }))`
  3. Dispatch a bubbling `change` event on `zipInput`.
  4. Return `p`.
- **`assignFilesWithDataTransfer`:** puts the file in a `DataTransfer` and assigns its `files` to the input.
  - jsdom has no `DataTransfer`, so the tests pass an `assignFiles` that sets `files` with `Object.defineProperty`.
  - The contract check (Task 9) exercises the real version in Chromium.
- **`installFakeUpstream`:**
  - Evaluates the real `app/src/unzip.js` and `app/src/parser.js` in the jsdom window, with a `pako` shim built on fflate.
  - Creates one `FogParser.FogMap`.
  - Adds a `change` listener on `#zip` that copies `loadFromZip` from `app/src/main.js`: `await file.arrayBuffer()`, `FogZip.unzip`, then the synchronous `addTile` loop.

- [ ] **Step 1: Write the failing tests**

```ts
// fogCache.test.ts: each test gets a fresh `new IDBFactory()` from fake-indexeddb
it("misses, then hits after putOnly", async () => {
  const c = await openFogCache(idb, true);
  expect(await c.get(A)).toBeNull();
  await c.putOnly(A, a);
  expect(await c.get(A)).toEqual(a);
});
it("keeps only the latest copy", async () => {
  const c = await openFogCache(idb, true);
  await c.putOnly(A, a);
  await c.putOnly(B, b);
  expect(await c.get(A)).toBeNull();
  expect(await c.get(B)).toEqual(b);
});
it("survives being reopened", async () => {
  await (await openFogCache(idb, true)).putOnly(A, a);
  expect(await (await openFogCache(idb, true)).get(A)).toEqual(a);
});
it("clearAll empties it", async () => {
  const c = await openFogCache(idb, true);
  await c.putOnly(A, a);
  await c.clearAll();
  expect(await c.get(A)).toBeNull();
});
it("does nothing when disabled", async () => {
  const c = await openFogCache(idb, false);
  await c.putOnly(A, a);
  expect(await c.get(A)).toBeNull();
});
it("never rejects when IndexedDB is broken", async () => {
  const broken = { open: () => { throw new Error("SecurityError"); } } as unknown as IDBFactory;
  const c = await openFogCache(broken, true);
  await expect(c.putOnly(A, a)).resolves.toBeUndefined();
  expect(await c.get(A)).toBeNull();
});

// receive.test.ts: chunksOf(bytes, size) builds ChunkMessages using node:crypto's SHA-256 as the fingerprint
it("reassembles chunks in order", async () => {
  const [c0, c1, c2] = chunksOf(bytes9, 3);
  const r = createReceiver(fp9, sha256Hex);
  expect(await r.accept(c0)).toEqual({ kind: "partial", receivedBytes: 3 });
  expect(await r.accept(c1)).toEqual({ kind: "partial", receivedBytes: 6 });
  expect(await r.accept(c2)).toEqual({ kind: "complete", bytes: bytes9 });
});
it("reassembles chunks out of order", async () => { /* c2, c0, c1 → the last result is complete with bytes9 */ });
it("ignores a duplicate chunk", async () => { /* c0, c0 → the second is { kind: "partial", receivedBytes: 3 } */ });
it("reports a mismatch when the bytes don't match the fingerprint", async () => { /* chunks of bytes9 under fingerprint "b".repeat(64) → mismatch */ });

// loader.test.ts: installFakeUpstream(window, document) in beforeEach; assignFiles uses Object.defineProperty
const load = (bytes: Uint8Array) => loadCopy(bytes, "fog.zip", { zipInput, hooks, assignFiles });
it("RF4: reports ok and the tile count for the standard backup", async () =>
  expect(await load(standardBackup())).toEqual({ ok: true, tiles: 2 }));
it("reports noTiles for a zip without tiles", async () =>
  expect(await load(notABackup())).toEqual({ ok: false, reason: "noTiles" }));
it("reports unzip for bytes that aren't a zip", async () =>
  expect(await load(new Uint8Array([1, 2, 3]))).toEqual({ ok: false, reason: "unzip" }));
it("reports memory when unzip runs out of memory", async () => {
  // replace window.FogZip.unzip with one that throws new RangeError("Array buffer allocation failed"), then install the hooks
  expect(await load(standardBackup())).toEqual({ ok: false, reason: "memory" });
});
it("reports unknown when unzip isn't called within 30 s", async () => {
  vi.useFakeTimers();
  // replace #zip with a clone so defog's change listener is gone
  const p = load(standardBackup());
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await p).toEqual({ ok: false, reason: "unknown" });
});
it("counts only this load's tiles when defog merges loads", async () => {
  await load(standardBackup());
  expect(await load(standardBackup())).toEqual({ ok: true, tiles: 2 });
});
it("names a missing upstream global", () => {
  delete (window as { FogZip?: unknown }).FogZip;
  expect(() => installOutcomeHooks(window)).toThrow("adapter contract: FogZip.unzip missing");
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm exec vitest run --project adapter test/adapter/{fogCache,receive,loader}.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the three modules and `fakeUpstream.ts`**

If jsdom's `Blob` lacks `arrayBuffer()`, `fakeUpstream.ts` polyfills it with `FileReader`.

- [ ] **Step 4: Run the tests and check that they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Mutation check**

Run: `cd mobile && pnpm exec stryker run --mutate "web-adapter/{fogCache,receive,loader}.ts"`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add mobile/web-adapter mobile/test/adapter
git commit -m "feat(mobile): adapter cache, chunk receiver and load outcome hooks"
```

---

### Task 7: Adapter status line, session and entry point

**Files:**
- Create in `mobile/web-adapter/`: `status.ts`, `session.ts`, `devTools.ts`, `index.ts`
- Test in `mobile/test/adapter/`: `status.test.ts`, `session.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 3, 5 and 6.
  - From Task 1, if available: `CACHE_ENABLED` and `CRYPTO_SUBTLE`.
- Produces:

```ts
// status.ts
export interface StatusActions { update(): void; clear(): void; about(): void; retry(): void }
export interface Status {
  showSaved(copy: { name: string; savedAt: string }): void;
  showProgress(receivedBytes: number, totalBytes: number): void;
  showRetry(kind: "failed" | "suspended"): void;
  showNotice(text: string): void;
  hide(): void; // empties the saved/progress/retry line; the notice stays
}
export function createStatus(doc: Document, actions: StatusActions, now: () => number): Status;
export function formatDate(iso: string): string;
export function ageLabel(days: number): string | null;
export function formatMb(bytes: number): string;
// session.ts
export interface SessionDeps {
  send: Send;
  cache: FogCache;
  status: Status;
  load(bytes: Uint8Array, name: string): Promise<LoadOutcome>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
  handleBack(): boolean;
}
export function createSession(deps: SessionDeps): { onMessage(msg: NativeToWeb): Promise<void> };
export function createStatusActions(send: Send): StatusActions;
// devTools.ts
export function installDevTools(doc: Document, cache: FogCache): void;
```

`createStatusActions` maps the actions to messages:

| Action | Message |
|---|---|
| `update` | `pickBackup` |
| `clear` | `clearSavedFog` |
| `about` | `openAbout` |
| `retry` | `retryRestore` |

**Status DOM:**
- A container `#crossfogStatus`, inserted right after `#loadStatus`, holding `#crossfogLine` and `#crossfogNotice`.
- One small `<style>` element.
- File names and notices are set with `textContent`, never `innerHTML`.

**Exact copy** (§3.6, decision 7):
- **Saved line:** "Saved backup ‹name›, imported ‹date›", followed by the buttons "Update", "Clear saved fog" and "About", separated by " · ".
  - From 7 days old, the date reads "‹date› (‹age›)" and gets the class `crossfog-stale`.
  - The age in days is `floor((now − savedAt) / 86,400,000)`.
- **Progress:** "Loading your fog… ‹received› / ‹total› MB".
- **Retry panel:**
  - Suspended: "Your saved fog couldn't be opened. The last attempt ran out of memory."
  - Failed: "Your saved fog couldn't be opened."
  - Buttons: "Retry", "Choose another backup" (calls `update`) and "Clear saved fog".
- **Brand:** `#brandName` reads "CROSS THE FOG".
- **Dev tools:** a "Dev: drop fog cache" button that calls `cache.clearAll()`.
- **Dates and sizes:**
  - `formatDate` uses the local date and the fixed month names Jan … Dec.
  - `formatMb` uses 1,000,000 bytes per MB: one decimal below 10 MB, whole numbers from 10 MB.

**Session rules** (§3.4, §3.6, decisions 1 and 4):

| Message | Effect |
|---|---|
| `none` | `cache.clearAll()`, then `status.hide()` |
| `restore` | Becomes the active copy. On a cache hit, load the cached bytes. Otherwise send `needBytes` and show progress 0 / `size`. |
| `chunk` for the active fingerprint | Feed the receiver. `partial` → show progress. `complete` → load. `mismatch` → send `needBytes` once more; a second mismatch reports `checksum`. |
| `chunk` for another fingerprint | Ignore |
| `restoreSuspended` | `status.showRetry("suspended")` |
| `notice` | `status.showNotice(text)` |
| `back` | Send `back:result` with `handleBack()` |

After every load, send `loaded`:
- On success, call `status.showSaved`. If the bytes were transferred rather than read from the cache, also call `cache.putOnly`.
- On failure, call `status.showRetry("failed")`, but only for role `current`.

**`index.ts`**, in this order:
1. `z.config({ jitless: true })`, because the page's CSP has no `unsafe-eval`.
2. `installLinks` and `installDownloads`, straight away.
3. On `DOMContentLoaded`:
   1. Set the brand text.
   2. `installImportButtons`.
   3. `installOutcomeHooks(window)`.
   4. `openFogCache(indexedDB, CACHE_ENABLED)`.
   5. `createStatus`.
   6. `createSession`, with `load` = `loadCopy` and `assignFilesWithDataTransfer`, and `sha256Hex` = `crypto.subtle.digest` plus `toHex` (or `@noble/hashes` where `CRYPTO_SUBTLE` says no).
   7. `installDevTools`, only when `__CROSSFOG_DEV_TOOLS__`.
   8. `onNativeMessage`.
   9. Last, `send({ v: 1, type: "ready" })`.

`index.ts` has no unit test; the contract check (Task 9) runs it.

- [ ] **Step 1: Write the failing tests**

```ts
// status.test.ts: loadUpstreamDom(document); now = () => Date.parse("2026-10-01T12:00:00.000Z")
it.each([
  [6, null], [7, "1 week old"], [13, "1 week old"], [14, "2 weeks old"],
  [59, "8 weeks old"], [60, "2 months old"], [400, "13 months old"],
])("ageLabel(%i) is %j", (days, label) => expect(ageLabel(days)).toBe(label));
it("formats dates with fixed month names", () => {
  expect(formatDate("2026-09-12T12:00:00.000Z")).toBe("12 Sep 2026");
  expect(formatDate("2026-01-05T12:00:00.000Z")).toBe("5 Jan 2026");
});
it.each([[0, "0.0"], [2_500_000, "2.5"], [12_400_000, "12"], [50_000_000, "50"]])(
  "formatMb(%i) is %s", (bytes, text) => expect(formatMb(bytes)).toBe(text));
it("shows the saved line right under #loadStatus", () => {
  status.showSaved({ name: "fog.zip", savedAt: "2026-09-28T12:00:00.000Z" });
  expect(document.getElementById("loadStatus")!.nextElementSibling!.id).toBe("crossfogStatus");
  expect(line().textContent).toContain("Saved backup fog.zip, imported 28 Sep 2026");
  expect(line().querySelector(".crossfog-stale")).toBeNull();
});
it("highlights a backup that is 7 days old or more", () => {
  status.showSaved({ name: "fog.zip", savedAt: "2026-09-10T12:00:00.000Z" });
  expect(line().querySelector(".crossfog-stale")!.textContent).toBe("10 Sep 2026 (3 weeks old)");
});
it("shows a hostile file name as text", () => {
  status.showSaved({ name: "<img src=x onerror=alert(1)>.zip", savedAt: "2026-09-28T12:00:00.000Z" });
  expect(line().querySelector("img")).toBeNull();
  expect(line().textContent).toContain("<img src=x onerror=alert(1)>.zip");
});
it("wires every button to its action", () => {
  // Update, Clear saved fog and About on the saved line; Retry, Choose another backup and
  // Clear saved fog on the retry panel. Each click calls the matching spy once.
});
it("shows progress", () => {
  status.showProgress(12_400_000, 50_000_000);
  expect(line().textContent).toBe("Loading your fog… 12 / 50 MB");
});
it.each([
  ["suspended", "Your saved fog couldn't be opened. The last attempt ran out of memory."],
  ["failed", "Your saved fog couldn't be opened."],
] as const)("shows the %s retry panel", (kind, text) => {
  status.showRetry(kind);
  expect(line().textContent).toContain(text);
});
it("hide keeps the notice", () => {
  status.showNotice("That file isn't a Fog of World backup. Your saved fog is unchanged.");
  status.hide();
  expect(document.getElementById("crossfogNotice")!.textContent)
    .toBe("That file isn't a Fog of World backup. Your saved fog is unchanged.");
});
it("the dev button drops the cache", async () => { /* installDevTools; click "Dev: drop fog cache"; cache.clearAll called */ });

// session.test.ts: an in-memory FogCache, a Status that records calls,
// a load stub with queued outcomes, and sha256Hex from node:crypto
it("first run: none empties the cache and hides the line", ...);
it("restores from the cache without asking native", async () => {
  // cache holds fp → bytes; onMessage(restore role current)
  expect(sent).toEqual([{ v: 1, type: "loaded", fingerprint: fp, ok: true, tiles: 2 }]);
  expect(status.calls).toContainEqual(["showSaved", { name: "fog.zip", savedAt }]);
});
it("asks for the bytes on a miss, and caches them only after a good load", async () => {
  // cache holds OLD; restore fp (role pending) → sent[0] is needBytes { fingerprint: fp }
  // feed every chunk → loaded ok; cache.get(fp) equals the bytes; cache.get(OLD) is null
});
it("a failed import leaves the old cache entry alone", async () => {
  // role pending; load returns noTiles → loaded { ok: false, reason: "noTiles" }
  // cache.get(OLD) still returns the old bytes; showRetry is never called
});
it("a failed saved copy shows the retry panel", ...); // role current + noTiles → showRetry("failed")
it("retries a checksum mismatch once, then reports checksum", ...); // two needBytes, then loaded { reason: "checksum" }
it("ignores chunks for another fingerprint", ...);
it("restoreSuspended shows the suspended panel", ...);
it("notice shows its text", ...);
it("back reports whether the sheet closed", ...); // handleBack true → { handled: true }; false → { handled: false }
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm exec vitest run --project adapter test/adapter/{status,session}.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the four modules**

- [ ] **Step 4: Run all adapter tests and the type check**

Run: `cd mobile && pnpm exec vitest run --project adapter && pnpm typecheck`
Expected: PASS, and exit 0.

- [ ] **Step 5: Mutation check**

Run: `cd mobile && pnpm exec stryker run --mutate "web-adapter/{status,session,devTools}.ts"`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add mobile/web-adapter mobile/test/adapter
git commit -m "feat(mobile): adapter session, saved-fog line and retry panel"
```

---

### Task 8: Web build

**Files:**
- Create in `mobile/scripts/web/`: `hostPolicy.ts`, `hosts.ts`, `csp.ts`, `transform.ts`, `bundleAdapter.ts`
- Create: `mobile/scripts/build-web.ts`
- Modify `mobile/package.json` scripts:
  - Add `generate`: `tsx scripts/build-web.ts`.
  - `typecheck`, `start`, `android` and `ios` become `pnpm generate && <previous command>`.
  - Add `eas-build-post-install`: `pnpm generate`.
- Test in `mobile/test/unit/web/`: `hosts.test.ts`, `csp.test.ts`, `transform.test.ts`

**Interfaces:**
- Consumes: `web-adapter/index.ts` (Task 7).
- Produces:

```ts
// hostPolicy.ts
export const HOST_POLICY = {
  connect: ["brouter.de", "overpass-api.de"],
  img: ["tile.openstreetmap.org", "*.tile-cyclosm.openstreetmap.fr"],
  external: ["www.google.com", "drive.google.com", "onedrive.live.com"],
  namespaces: ["www.opengis.net", "www.topografix.com"],
  removedWithGoatCounter: ["szapalak.goatcounter.com"],
} as const;
// hosts.ts
export function scanHosts(sources: string[]): string[];  // sorted, unique; "{s}." becomes "*."
export function unknownHosts(found: string[]): string[]; // hosts in no HOST_POLICY list
// csp.ts
export function scriptHash(code: string): string;        // "'sha256-<base64>'"
export function buildCsp(scriptHashes: string[]): string;
// transform.ts
export class BuildError extends Error {}
export function transformIndexHtml(html: string, readLocal: (relPath: string) => string, adapterJs: string): string;
// bundleAdapter.ts
export function bundleAdapter(opts: { devTools: boolean }): Promise<string>;
// build-web.ts
export function buildWebHtml(opts: { appDir: string; devTools: boolean; editIndex?: (html: string) => string }): Promise<string>;
// Run as a CLI, it writes generated/web.ts (`export const WEB_HTML: string`), with dev tools on when CROSSFOG_E2E=1.
```

For the hashes `[h1, h2]`, `buildCsp` returns exactly:

```
default-src 'none'; script-src h1 h2; style-src 'unsafe-inline'; img-src data: https://tile.openstreetmap.org https://*.tile-cyclosm.openstreetmap.fr; connect-src https://brouter.de https://overpass-api.de; base-uri 'none'; form-action 'none'
```

**`transformIndexHtml`** (§3.1), using linkedom, in this order:
1. Remove `script[data-goatcounter]`.
2. Replace each `<script src>` and `<link rel="stylesheet" href>` that has a relative URL with an inline `<script>` or `<style>` holding `readLocal(path)`. In inlined JS, `</script` becomes `<\/script`.
3. Throw for any absolute or protocol-relative (`//…`) URL that remains: `BuildError("External script not allowed: <src>")` or `BuildError("External stylesheet not allowed: <href>")`.
4. Right after `<meta charset>` (or first in `<head>` when there's none), insert the CSP `<meta http-equiv="Content-Security-Policy" content="…">`, then the adapter `<script>`.
5. Hash every inline script exactly as it appears in the output.

**`buildWebHtml`:**
1. Read `<appDir>/index.html` and pass it through `editIndex`.
2. Run `scanHosts` over it and `<appDir>/src/*.js`. If `unknownHosts` isn't empty, throw `BuildError("Unknown host(s) in app/: <list>. Review them, then add each to scripts/web/hostPolicy.ts.")`.
3. Bundle the adapter.
4. Transform.

**`bundleAdapter`:** esbuild with `bundle`, `format: "iife"`, `target: ["safari16.4", "chrome120"]`, `minify`, `write: false`, and `define: { __CROSSFOG_DEV_TOOLS__: String(devTools) }`.

- [ ] **Step 1: Write the failing tests**

```ts
// transform.test.ts
const page = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="vendor/a.css"></head>
<body><p id="x"></p>
<script data-goatcounter="https://szapalak.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
<script src="src/one.js"></script><script src="src/two.js"></script></body></html>`;
const files: Record<string, string> = {
  "vendor/a.css": "p{color:red}", "src/one.js": "var one = 1;", "src/two.js": 'var s = "</script>";',
};
const run = (html = page) => transformIndexHtml(html, (p) => files[p]!, "var adapter = 1;");
const parse = (html: string) => parseHTML(html).document; // linkedom

it("removes GoatCounter", () => expect(run()).not.toContain("goatcounter"));
it("puts the CSP right after the charset, then the adapter", () => {
  const head = parse(run()).head.children;
  expect(head[0]!.getAttribute("charset")).toBe("utf-8");
  expect(head[1]!.getAttribute("http-equiv")).toBe("Content-Security-Policy");
  expect(head[2]!.textContent).toBe("var adapter = 1;");
});
it("inlines local scripts in order, escaping </script", () => {
  const scripts = [...parse(run()).querySelectorAll("script")].map((s) => s.textContent);
  expect(scripts).toEqual(["var adapter = 1;", "var one = 1;", 'var s = "<\\/script>";']);
});
it("inlines local stylesheets", () => expect(parse(run()).querySelector("style")!.textContent).toBe("p{color:red}"));
it("lists the hash of every inline script in the CSP", () => {
  const doc = parse(run());
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
  for (const s of doc.querySelectorAll("script")) expect(csp).toContain(scriptHash(s.textContent!));
});
it("fails on an external script", () =>
  expect(() => run(page.replace("src/two.js", "https://cdn.example.com/x.js")))
    .toThrow("External script not allowed: https://cdn.example.com/x.js"));
it("fails on a protocol-relative script", () =>
  expect(() => run(page.replace("src/two.js", "//cdn.example.com/x.js")))
    .toThrow("External script not allowed: //cdn.example.com/x.js"));
it("fails on an external stylesheet", () =>
  expect(() => run(page.replace("vendor/a.css", "https://cdn.example.com/a.css")))
    .toThrow("External stylesheet not allowed: https://cdn.example.com/a.css"));

// csp.test.ts
it("hashes like the browser", () =>
  expect(scriptHash("alert(1)")).toBe(`'sha256-${createHash("sha256").update("alert(1)").digest("base64")}'`));
it("builds the exact policy", () =>
  expect(buildCsp(["'sha256-a'", "'sha256-b'"])).toBe(
    "default-src 'none'; script-src 'sha256-a' 'sha256-b'; style-src 'unsafe-inline'; img-src data: https://tile.openstreetmap.org https://*.tile-cyclosm.openstreetmap.fr; connect-src https://brouter.de https://overpass-api.de; base-uri 'none'; form-action 'none'",
  ));

// hosts.test.ts: readAppSources() returns app/index.html and every app/src/*.js
it("finds exactly the reviewed hosts in app/", () => {
  const found = scanHosts(readAppSources());
  expect(found).toEqual([
    "*.tile-cyclosm.openstreetmap.fr", "brouter.de", "drive.google.com", "onedrive.live.com",
    "overpass-api.de", "szapalak.goatcounter.com", "tile.openstreetmap.org", "www.google.com",
    "www.opengis.net", "www.topografix.com",
  ]);
  expect(unknownHosts(found)).toEqual([]);
});
it("flags a new host", () =>
  expect(unknownHosts(scanHosts(['fetch("https://evil.example/x")']))).toEqual(["evil.example"]));
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm exec vitest run --project unit test/unit/web`
Expected: FAIL

- [ ] **Step 3: Implement the modules and the CLI**

- [ ] **Step 4: Run the tests, then build the page**

```bash
cd mobile
pnpm exec vitest run --project unit test/unit/web   # Expected: PASS
pnpm generate                                       # Expected: "generated/web.ts (<n> KB)"
pnpm typecheck                                      # Expected: exit 0
```

- [ ] **Step 5: Mutation check**

Run: `cd mobile && pnpm exec stryker run --mutate "scripts/web/{hostPolicy,hosts,csp,transform}.ts"`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add mobile/scripts mobile/test/unit/web mobile/package.json
git commit -m "feat(mobile): build the self-contained page with CSP and host check"
```

---

### Task 9: Contract check

**Files:**
- Create: `mobile/scripts/web/contract.ts`, `mobile/scripts/contract-check.ts`
- Modify `mobile/package.json` scripts:
  - Add `contract`: `playwright install chromium && tsx scripts/contract-check.ts`.
  - Add `build:web`: `pnpm generate && pnpm contract`.
  - Add `test:contract`: `playwright install chromium && vitest run -c vitest.contract.config.ts`.
  - `verify` gains `&& pnpm test:contract && pnpm build:web`.
- Test: `mobile/test/contract/contract.test.ts`

**Interfaces:**
- Consumes:
  - From Task 8: `buildWebHtml` and `WEB_HTML`.
  - From Task 4: the fixtures.
  - From Task 3: `ORIGIN`, `encode` and `encodeBase64`.
- Produces:

```ts
export function runContractCheck(
  html: string,
  fixture: { zip: Uint8Array; name: string; tiles: number },
): Promise<{ failures: string[] }>;
```

The check uses Playwright Chromium. It never throws for a broken page; each problem adds one of these exact failure messages:

| # | Check | Failure message |
|---|---|---|
| 1 | Elements `#zip`, `#folder`, `#loadStatus`, `#sidebar`, `#brandName` exist | `missing element #<id>` |
| 2 | Globals `FogZip.unzip` and `FogParser.FogMap.prototype.addTile` exist | `missing global <path>` |
| 3 | The adapter sends `ready` within 10 s | `adapter never sent ready` |
| 4 | Send `restore` (role `current`, `size` = the zip's length) and answer `needBytes` with 64 KB chunks. `loaded` with `ok: true` and `fixture.tiles` arrives within 30 s. | `fixture load reported <JSON of what arrived, or "nothing">` |
| 5 | `fetch("https://example.com/")` in the page fires a `securitypolicyviolation` event | `CSP did not block connect-src` |
| 6 | No request to `ORIGIN` other than the document | `page requested <url>` |
| 7 | No uncaught page error | `page error: <message>` |

How the check runs:
- **Network:** every request is intercepted. `ORIGIN` gets the HTML; everything else is recorded and aborted.
- **Bridge stub:** `addInitScript` defines `window.ReactNativeWebView` so that the page's messages are collected.
- **Native → page messages:** dispatched as `window.dispatchEvent(new MessageEvent("message", { data }))`, the way iOS does it.

- [ ] **Step 1: Write the failing tests**

```ts
const fixture = { zip: standardBackup(), name: "standard.zip", tiles: STANDARD_TILE_COUNT };
const build = (editIndex?: (html: string) => string) =>
  buildWebHtml({ appDir: "../app", devTools: false, ...(editIndex ? { editIndex } : {}) });

it("RF4: the generated page loads the standard backup", async () =>
  expect((await runContractCheck(await build(), fixture)).failures).toEqual([]));
it("names a missing element", async () => {
  const { failures } = await runContractCheck(await build((h) => h.replace('id="zip"', 'id="zap"')), fixture);
  expect(failures).toContain("missing element #zip");
});
it("names a missing global", async () => {
  const { failures } = await runContractCheck(
    await build((h) => h.replace('<script src="src/unzip.js"></script>', "")), fixture);
  expect(failures).toContain("missing global FogZip.unzip");
});
it("fails when the fixture's tile count doesn't match", async () => {
  const { failures } = await runContractCheck(await build(), { ...fixture, tiles: 3 });
  expect(failures.some((f) => f.startsWith("fixture load reported"))).toBe(true);
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm test:contract`
Expected: FAIL

- [ ] **Step 3: Implement `contract.ts` and the CLI**

The CLI runs the check on `WEB_HTML` with the standard fixture. It prints every failure and exits 1, or prints "Contract check passed".

- [ ] **Step 4: Run the tests and the build, and check that they pass**

```bash
cd mobile
pnpm test:contract   # Expected: PASS
pnpm build:web       # Expected: "Contract check passed"
pnpm verify          # Expected: exit 0
```

- [ ] **Step 5: Commit**

```bash
git add mobile/scripts mobile/test/contract mobile/package.json
git commit -m "feat(mobile): contract check runs the generated page in Chromium"
```

---

### Task 10: Fog store, restore guard and transfer

**Files:**
- Create in `mobile/src/fog/`: `fileStore.ts`, `store.ts`, `restoreGuard.ts`, `transfer.ts`
- Create: `mobile/test/support/memoryFileStore.ts`
- Test in `mobile/test/unit/fog/`: `store.test.ts`, `restoreGuard.test.ts`, `transfer.test.ts`

**Interfaces:**
- Consumes:
  - From Task 3: `NativeToWeb`, `encodeBase64`.
  - From Task 1, if available: `CHUNK_BYTES`.
- Produces:

```ts
// fileStore.ts: names are plain file names inside one directory
export interface FileStore {
  list(): Promise<string[]>;
  exists(name: string): Promise<boolean>;
  readText(name: string): Promise<string | null>;             // null when missing
  createText(name: string, text: string): Promise<void>;      // writes `${name}.tmp`, then renames; rejects if name exists
  readBytes(name: string): Promise<Uint8Array>;
  readRange(name: string, offset: number, length: number): Promise<Uint8Array>;
  size(name: string): Promise<number>;
  importFrom(sourceUri: string, name: string): Promise<void>; // copies a file from outside the directory
  rename(from: string, to: string): Promise<void>;            // rejects with FileExistsError if `to` exists
  remove(name: string): Promise<void>;                        // does nothing when missing
}
export class FileExistsError extends Error {}
// store.ts
export interface SourceFile { uri: string; name: string }
export interface CopyMeta { name: string; sha256: string; size: number; savedAt: string; source: "picker" | "share" }
export interface FogStore {
  recover(): Promise<{ discardedPending: boolean }>;
  current(): Promise<CopyMeta | null>;
  pending(): Promise<CopyMeta | null>;
  beginImport(file: SourceFile, source: CopyMeta["source"]): Promise<CopyMeta>;
  promotePending(): Promise<void>;
  discardPending(): Promise<void>;
  clear(): Promise<void>;
}
export function zipName(meta: CopyMeta): string; // `${meta.sha256}.zip`
export function createFogStore(
  fs: FileStore,
  deps: { sha256Hex(bytes: Uint8Array): Promise<string>; now(): number },
): FogStore;
// restoreGuard.ts: keeps the file "restoring.json" { fingerprint, attempts }
export interface RestoreGuard {
  beforeRestore(fingerprint: string): Promise<"restore" | "suspended">;
  onLoaded(): Promise<void>;
  reset(): Promise<void>;
}
export function createRestoreGuard(fs: FileStore, maxAttempts?: number): RestoreGuard; // default 2
// transfer.ts
export const CHUNK_BYTES = 1_048_576; // tuned by S2
export function chunkCount(size: number, chunkBytes: number): number; // max(1, ceil(size / chunkBytes))
export function streamCopy(args: {
  fs: FileStore; zipName: string; fingerprint: string;
  send(msg: NativeToWeb): void; chunkBytes: number; signal: AbortSignal;
}): Promise<void>;
// test/support/memoryFileStore.ts
export class SimulatedCrash extends Error {}
export interface MemoryFileStore extends FileStore { files: Map<string, Uint8Array>; mutations: number }
export function createMemoryFileStore(opts?: {
  files?: Map<string, Uint8Array>; sources?: Record<string, Uint8Array>; crashAtMutation?: number;
}): MemoryFileStore;
```

**Memory store:**
- Each of these counts as one mutation: a temporary write, a rename, an import and a remove.
- The `crashAtMutation`-th mutation throws `SimulatedCrash` before it takes effect.
- Passing a crashed store's `files` map to a new memory store simulates the next launch.

**Store algorithms** (decision 2). Pointer files are named `current-000001.json`, `current-000002.json`, and so on.
- **`beginImport`:**
  1. Remove any leftover `incoming.tmp`.
  2. `importFrom(uri, "incoming.tmp")`, then hash it.
  3. If `<sha>.zip` already exists, remove `incoming.tmp` (RF1). Otherwise rename it to `<sha>.zip`.
  4. `createText("pending.json", meta)`, with `savedAt = new Date(now()).toISOString()`.
- **`promotePending`:**
  1. `createText` the pointer numbered n+1 with the pending meta.
  2. Remove every pointer numbered n or less.
  3. Remove `pending.json`.
  4. gc.
- **`discardPending`:** remove `pending.json`, then gc.
- **`clear`:** remove `pending.json` and every pointer, then gc.
- **`recover`:**
  1. Remove every `*.tmp`.
  2. Keep the highest pointer that parses as `CopyMeta` and whose zip exists. Remove all other pointers.
  3. `discardedPending` is whether `pending.json` existed. Remove it.
  4. gc.
- **gc:** remove every `*.zip` that neither the current pointer nor `pending.json` names.
- **`current()` and `pending()`:** parse with a Zod `CopyMeta` schema. Invalid JSON counts as absent.

**Restore guard** (decision 3):
- **`beforeRestore(fp)`:**
  - Read the record. `attempts` is the record's count when its fingerprint is `fp`, otherwise 0.
  - If `attempts` ≥ `maxAttempts`, return `"suspended"` and keep the record.
  - Otherwise write `{ fingerprint: fp, attempts: attempts + 1 }` (remove, then `createText`) and return `"restore"`.
- **`onLoaded` and `reset`:** remove the record.
- A corrupt record counts as absent.

- [ ] **Step 1: Write the failing tests**

```ts
// store.test.ts
const A = new Uint8Array([1, 2, 3]);
const B = new Uint8Array([4, 5, 6]);
const sources = { "file:///inbox/a.zip": A, "file:///inbox/b.zip": B };
const deps = { sha256Hex: nodeSha256Hex, now: () => Date.parse("2026-10-01T09:00:00.000Z") };
const fileA = { uri: "file:///inbox/a.zip", name: "a.zip" };
const fileB = { uri: "file:///inbox/b.zip", name: "b.zip" };
// save(store, file): beginImport(file, "picker") followed by promotePending()

it("starts empty", ...); // current() and pending() are null; recover() → { discardedPending: false }
it("beginImport copies the file and records it as pending", async () => {
  const meta = await store.beginImport(fileA, "picker");
  expect(meta).toEqual({ name: "a.zip", sha256: sha(A), size: 3, savedAt: "2026-10-01T09:00:00.000Z", source: "picker" });
  expect(await store.pending()).toEqual(meta);
  expect(await store.current()).toBeNull();
  expect(fs.files.get(`${sha(A)}.zip`)).toEqual(A);
});
it("promotes pending to current", async () => {
  await save(store, fileA);
  expect(await store.current()).toMatchObject({ sha256: sha(A) });
  expect(await store.pending()).toBeNull();
  expect([...fs.files.keys()].sort()).toEqual([`${sha(A)}.zip`, "current-000001.json"]);
});
it("a new import replaces the saved copy and drops the old zip", async () => {
  await save(store, fileA);
  await save(store, fileB);
  expect([...fs.files.keys()].sort()).toEqual([`${sha(B)}.zip`, "current-000002.json"]);
});
it("discarding an import never touches the saved copy", ...); // save A; begin B; discard → current is A, B's zip is gone
it("RF1: re-importing the saved backup keeps its zip", async () => {
  await save(store, fileA);
  await save(store, fileA);
  expect(fs.files.get(`${sha(A)}.zip`)).toEqual(A);
  await store.beginImport(fileA, "share");
  await store.discardPending();
  expect(await store.current()).toMatchObject({ sha256: sha(A) });
  expect(fs.files.get(`${sha(A)}.zip`)).toEqual(A);
});
it("clear removes every fog file", ...); // save A; clear → no *.zip, no pointer, no pending.json
it("recover removes leftovers and keeps the saved copy", async () => {
  await save(store, fileA);
  for (const n of ["incoming.tmp", "current-000009.json.tmp", `${"d".repeat(64)}.zip`, "pending.json"])
    fs.files.set(n, new Uint8Array([0]));
  expect(await store.recover()).toEqual({ discardedPending: true });
  expect([...fs.files.keys()].sort()).toEqual([`${sha(A)}.zip`, "current-000001.json"]);
});
it("RF3: a crash at any step of an import leaves the old copy or the new one", async () => {
  const total = await mutationsFor((s) => save(s, fileB), { savedFirst: fileA }); // dry run counts the mutations
  for (let k = 1; k <= total; k++) {
    const crashed = await storeWithSaved(fileA, { crashAfterSetup: k });       // crashes at the k-th mutation of the import
    await expect(save(crashed.store, fileB)).rejects.toBeInstanceOf(SimulatedCrash);
    const fs2 = createMemoryFileStore({ files: crashed.fs.files, sources });
    const next = createFogStore(fs2, deps);
    await next.recover();
    const cur = await next.current();
    expect([sha(A), sha(B)]).toContain(cur?.sha256);
    expect(fs2.files.get(zipName(cur!))).toEqual(cur!.sha256 === sha(A) ? A : B);
    expect([...fs2.files.keys()].filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect([...fs2.files.keys()].filter((n) => n.startsWith("current-"))).toHaveLength(1);
  }
});
it("RF3: a crash during clear leaves the old copy or nothing, never a broken pointer", ...);
// the same loop over clear(): after recover(), current() is A (with its zip) or null

// restoreGuard.test.ts
it("allows two attempts per fingerprint, then suspends", async () => {
  expect(await guard.beforeRestore(A)).toBe("restore");
  expect(await guard.beforeRestore(A)).toBe("restore");
  expect(await guard.beforeRestore(A)).toBe("suspended");
});
it("stays suspended after the app restarts", ...); // a new guard over the same files → "suspended"
it("a load clears the count", ...);                // restore, onLoaded, restore, restore → both "restore"
it("another fingerprint starts again", ...);       // A, A, then B → "restore"
it("reset lifts a suspension", ...);
it("treats a corrupt record as none", ...);        // files.set("restoring.json", "{") → "restore"

// transfer.test.ts
it("splits a file into base64 chunks that reassemble", async () => {
  // a 10-byte file with chunkBytes 4 → three chunk messages, index 0..2, total 3,
  // all with the fingerprint; the decoded data joined together equals the file
});
it("stops when aborted", ...); // abort inside the first send() → exactly one message
it("counts chunks", () => {
  expect(chunkCount(0, 4)).toBe(1);
  expect(chunkCount(8, 4)).toBe(2);
  expect(chunkCount(9, 4)).toBe(3);
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm exec vitest run --project unit test/unit/fog`
Expected: FAIL

- [ ] **Step 3: Implement the four modules and `memoryFileStore.ts`**

Set `CHUNK_BYTES` from the findings if they exist.

- [ ] **Step 4: Run the tests and check that they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Mutation check**

Run: `cd mobile && pnpm exec stryker run --mutate "src/fog/*.ts"`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add mobile/src/fog mobile/test/support/memoryFileStore.ts mobile/test/unit/fog
git commit -m "feat(mobile): crash-safe fog store, restore guard and chunked transfer"
```

---

### Task 11: Controller and incoming files

**Files:**
- Create: `mobile/src/copy.ts`, `mobile/src/import/incoming.ts`, `mobile/src/import/incomingQueue.ts`, `mobile/src/controller.ts`
- Test: `mobile/test/unit/incoming.test.ts`, `mobile/test/unit/controller.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 10.
- Produces:

```ts
// copy.ts
export const COPY = {
  zipOnly: "Cross the Fog can only import .zip backups.",
  notABackup: "That file isn't a Fog of World backup. Your saved fog is unchanged.",
  importFailed: "That backup couldn't be opened. Your saved fog is unchanged.",
  exportFailed: "Couldn't share the file.",
  pressBackAgain: "Press back again to exit",
  replaceTitle: (name: string) => `Replace your saved fog with ${name}?`,
  replace: "Replace",
  clearTitle: "Clear saved fog?",
  clearMessage: "You'll need to import a backup again to see your fog.",
  clear: "Clear",
  cancel: "Cancel",
} as const;
// incoming.ts
export function acceptIncoming(name: string): boolean;                // ends with ".zip", any case
export function nameFromFileUrl(url: string): string;                 // last path segment, percent-decoded
export function fileFromSystemPath(path: string): SourceFile | null;  // file:// URLs only
export interface ShareFileLike { path: string; fileName?: string | null; mimeType?: string | null }
export function filesFromShareIntent(files: ShareFileLike[]): SourceFile[]; // bare paths get file://; MIME is ignored
export function isDisposableCopy(uri: string, roots: { cache: string; inbox: string }): boolean;
// incomingQueue.ts
export function enqueueIncoming(file: SourceFile): void;
export function subscribeIncoming(listener: (file: SourceFile) => void): () => void; // first replays queued files
// controller.ts
export interface ControllerDeps {
  store: FogStore;
  guard: RestoreGuard;
  fs: FileStore;
  send(msg: NativeToWeb): void;
  remount(): void;
  pickFile(): Promise<SourceFile | null>;  // null when cancelled
  confirmReplace(name: string): Promise<boolean>;
  confirmClear(): Promise<boolean>;
  notify(text: string): void;              // a toast on Android, an alert on iOS
  shareExport(file: { filename: string; mime: string; text: string }): Promise<void>;
  openExternal(url: string): Promise<void>;
  openAbout(): void;
  exitApp(): void;
  releaseSource(uri: string): Promise<void>;
  now(): number;
  chunkBytes: number;
}
export interface Controller {
  start(): Promise<void>;
  onWebMessage(msg: WebToNative): Promise<void>;
  onIncoming(file: SourceFile): Promise<void>;
  onProcessGone(): Promise<void>;
  onBackPressed(): void;
}
export function createController(deps: ControllerDeps): Controller;
```

**Controller rules** (§3.2–§3.5, §3.8; decisions 1, 3, 4, 8, 12 and 13).

Every handler first waits for `start()`. `start()` runs `store.recover()`, and queues `COPY.importFailed` if that discarded a pending import.

*Import state.* An import runs from the moment the picker opens, or a shared file is accepted, until its pending copy is promoted or discarded. It also ends when it fails before the pending copy exists.

*Page and notices.*
- **Showing a notice:** `send(notice)` if the page has sent `ready` since the last remount. Otherwise, queue it for the next `ready`.
- **Remount:** abort the running transfer, mark the page as not ready, then call `deps.remount()`.

*Messages from the page:*
- **`ready`:**
  - With a pending copy: send `restore` with role `pending`. The guard isn't used.
  - Otherwise, with a saved copy: `guard.beforeRestore`, then send `restore` with role `current`, or `restoreSuspended { savedAt }`.
  - Otherwise: send `none`.
  - Then send any queued notices.
- **`needBytes`:** stream the copy only if the fingerprint is the active restore's. Ignore anything else.
- **`loaded` for the pending copy:**
  - ok → `promotePending`.
  - not ok → `discardPending`, queue `COPY.notABackup`, remount.
  - Either way, the import is over.
- **`loaded` for the saved copy:** `guard.onLoaded()`.
- **`loaded` for any other fingerprint:** ignore.
- **`pickBackup`:**
  - Ignored during an import (RF2).
  - Cancelled pick: nothing happens.
  - A name that fails `acceptIncoming`: `notify(COPY.zipOnly)`.
  - Otherwise: `beginImport(file, "picker")`, then `releaseSource(file.uri)`, then remount.
  - An error before the pending copy exists: show `COPY.importFailed`.
- **`clearSavedFog`:** ignored during an import. If `confirmClear()` is true: `store.clear()`, `guard.reset()`, remount.
- **`retryRestore`:** `guard.reset()`, then remount.
- **`export`:** `shareExport`. If it rejects, `notify(COPY.exportFailed)`.
- **`openExternal`** and **`openAbout`:** pass straight to the dependency.
- **`back:result` with `handled: false`:** a second one within 2,000 ms of the first calls `exitApp()`. Otherwise, `notify(COPY.pressBackAgain)`.

*Native events:*
- **Incoming file (share):**
  - A name that fails `acceptIncoming`: `notify(COPY.zipOnly)`, then `releaseSource`.
  - During an import: keep only the latest file, and handle it when the import ends (decision 8).
  - With a saved copy: ask `confirmReplace(name)`. On no, only `releaseSource`.
  - Then import as for `pickBackup`, with source `share`.
- **`onBackPressed`:** send `back`.
- **`onProcessGone`:**
  - During an import with a pending copy: `discardPending`, queue `COPY.importFailed`, and end the import.
  - Then remount. The guard counts crashed restores by itself.

- [ ] **Step 1: Write the failing tests**

```ts
// incoming.test.ts
it.each([
  ["Backup.ZIP", true], ["fog.zip", true], ["fog.Zip", true],
  ["backup.zip.txt", false], ["photo.jpg", false], ["backup", false], ["", false],
])("RF5: acceptIncoming(%j) is %s", (name, ok) => expect(acceptIncoming(name)).toBe(ok));
it("reads names from file URLs", () =>
  expect(nameFromFileUrl("file:///var/mobile/Containers/Data/Application/X/Documents/Inbox/My%20Fog.zip"))
    .toBe("My Fog.zip"));
it("takes only file URLs from the system", () => {
  expect(fileFromSystemPath("file:///x/Inbox/a.zip")).toEqual({ uri: "file:///x/Inbox/a.zip", name: "a.zip" });
  expect(fileFromSystemPath("crossfog://about")).toBeNull();
  expect(fileFromSystemPath("/")).toBeNull();
});
it("RF5: accepts files shared as application/octet-stream", () =>
  expect(filesFromShareIntent([{
    path: "/data/user/0/codes.madera.crossfog/cache/fog.zip", fileName: "fog.zip", mimeType: "application/octet-stream",
  }])).toEqual([{ uri: "file:///data/user/0/codes.madera.crossfog/cache/fog.zip", name: "fog.zip" }]));
it("deletes only the app's own temporary copies", () => {
  const roots = { cache: "file:///app/Library/Caches/", inbox: "file:///app/Documents/Inbox/" };
  expect(isDisposableCopy("file:///app/Library/Caches/DocumentPicker/fog.zip", roots)).toBe(true);
  expect(isDisposableCopy("file:///app/Documents/Inbox/fog.zip", roots)).toBe(true);
  expect(isDisposableCopy("file:///app/Documents/fog/abc.zip", roots)).toBe(false);
  expect(isDisposableCopy("file:///storage/emulated/0/Download/fog.zip", roots)).toBe(false);
  expect(isDisposableCopy("content://com.android.providers.downloads/1", roots)).toBe(false);
});
it("replays files queued before the shell subscribed", ...);

// controller.test.ts: harness() builds a memory FileStore with sources, the real store and guard,
// and recording fakes: sent, remounts, notified, confirm answers, released, exited, clock.
// pickFile is a vi.fn that returns picks.shift() ?? null, so tests push to `picks` or use mockReturnValueOnce.
// ready = { v: 1, type: "ready" }; pickBackup = { v: 1, type: "pickBackup" }; fp() is node:crypto SHA-256.
it("first run sends none", async () => {
  await c.onWebMessage(ready);
  expect(sent).toEqual([{ v: 1, type: "none" }]);
});
it("restores the saved copy", async () => {
  // with A saved
  await c.onWebMessage(ready);
  expect(sent).toEqual([{
    v: 1, type: "restore", fingerprint: fp(A), name: "a.zip",
    savedAt: "2026-10-01T09:00:00.000Z", size: 3, role: "current",
  }]);
});
it("streams only the active copy", ...); // needBytes with another fingerprint → nothing; with fp(A) → chunk messages
it("imports a picked backup and keeps it after a good load", async () => {
  picks.push({ uri: "file:///cache/b.zip", name: "b.zip" });
  await c.onWebMessage(pickBackup);
  expect(remounts).toBe(1);
  expect(released).toEqual(["file:///cache/b.zip"]);
  await c.onWebMessage(ready);
  expect(sent.at(-1)).toMatchObject({ type: "restore", role: "pending", fingerprint: fp(B) });
  await c.onWebMessage({ v: 1, type: "loaded", fingerprint: fp(B), ok: true, tiles: 2 });
  expect((await store.current())?.sha256).toBe(fp(B));
  expect(remounts).toBe(1);
});
it("a bad import keeps the saved fog and says so", ...);
// A saved; import B; loaded { ok: false, reason: "noTiles" } → current is still A, remounts 2;
// then ready → restore of A with role current, followed by { v: 1, type: "notice", text: COPY.notABackup }
it("a bad first import says so with nothing saved", ...); // after ready: none, then the notABackup notice
it("RF2: a second pickBackup during the pick is ignored", async () => {
  const pick = deferred<SourceFile | null>();
  pickFile.mockReturnValueOnce(pick.promise);
  void c.onWebMessage(pickBackup);
  await c.onWebMessage(pickBackup);
  expect(pickFile).toHaveBeenCalledTimes(1);
});
it("RF2: a share during an import waits, then asks", async () => {
  // A saved; import B and stop before `loaded`; onIncoming(c.zip) → confirmReplace not called yet
  // loaded ok for B → confirmReplace called with "c.zip"; answer yes → another remount and pending C
});
it("asks before replacing with a shared file, and Cancel changes nothing", ...); // released; current A; no remount
it("imports a shared file without asking when nothing is saved", ...);
it("RF5: a non-zip share or pick gets the toast and no import", ...);
// share photo.jpg, pick notes.txt → notified [COPY.zipOnly, COPY.zipOnly], no remount, photo released
it("trips the guard after two crashed restores", async () => {
  // A saved: ready, onProcessGone, ready, onProcessGone, ready
  expect(sent.at(-1)).toEqual({ v: 1, type: "restoreSuspended", savedAt: "2026-10-01T09:00:00.000Z" });
});
it("Retry lifts the suspension", ...);              // retryRestore → remount; ready → restore again
it("Clear asks first, then empties the store", ...); // confirmClear false → nothing; true → current null, one remount
it("an import that crashes the WebView is discarded with a notice", ...);
// import B; onProcessGone → pending null, current A; ready → restore A, then notice COPY.importFailed
it("an import left over from an app crash is discarded at start", ...);
// files hold A saved plus a pending B; start(); ready → restore A, then notice COPY.importFailed
it("an export failure shows a toast", ...);
it("back twice within 2 s exits", ...);
// clock 0 → notified pressBackAgain; clock 1500 → exitApp; a fresh pair at 0 and 2500 → two toasts, no exit
it("forwards the back button to the page", () => {
  c.onBackPressed();
  expect(sent.at(-1)).toEqual({ v: 1, type: "back" });
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm exec vitest run --project unit test/unit/incoming.test.ts test/unit/controller.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `copy.ts`, `incoming.ts`, `incomingQueue.ts` and `controller.ts`**

- [ ] **Step 4: Run the tests and check that they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Mutation check**

Run: `cd mobile && pnpm exec stryker run --mutate "src/controller.ts,src/import/incoming.ts,src/import/incomingQueue.ts"`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add mobile/src/copy.ts mobile/src/import mobile/src/controller.ts mobile/test/unit
git commit -m "feat(mobile): controller for imports, restores, shares and back"
```

---

### Task 12: Native shell on devices

Start only after `mobile/docs/spike-findings.md` is committed.

**Files:**
- Create:
  - `mobile/src/platform/expoFileStore.ts`, `mobile/src/platform/sha256.ts`
  - `mobile/src/platform/crashLog.ts`
  - `mobile/src/import/pick.ts`, `mobile/src/import/share-mime.json`
  - `mobile/src/bridge/exportFile.ts`, `mobile/src/bridge/nativeHandlers.ts`
  - `mobile/src/WebShell.tsx`
  - `mobile/app/about.tsx` (a stub until Task 14)
  - `mobile/docs/manual-checklist.md`
- Modify: `mobile/app/_layout.tsx`, `mobile/app/index.tsx`
- Test: `mobile/test/unit/exportFile.test.ts`

**Interfaces:**
- Consumes:
  - From Task 3: protocol, `decideNavigation`, `isTrustedSource`, `toHex`.
  - From Task 8: `WEB_HTML`.
  - From Task 10: the store, guard and `CHUNK_BYTES`.
  - From Task 11: `createController`, `COPY`, `subscribeIncoming`, `isDisposableCopy`.
  - From Task 1: `SHARE_MIME`.
- Produces:

```ts
export function createExpoFileStore(dir: Directory): FileStore; // dir = new Directory(Paths.document, "fog"), created if missing
export function sha256Hex(bytes: Uint8Array): Promise<string>;  // expo-crypto digest(SHA256) + toHex
// crashLog.ts
export function logCrash(error: unknown): Promise<void>;
// Appends "<ISO timestamp>\t<error message>\n" to crash.log in Paths.document.
// Registered as ErrorUtils.setGlobalHandler in app/_layout.tsx.
// No UI; the developer reads it via Xcode/ADB. Never throws.
export function pickBackupFile(): Promise<SourceFile | null>;
// pickBackupFile: getDocumentAsync({ type: SHARE_MIME, copyToCacheDirectory: true, multiple: false })
export function utiFor(filename: string): string | undefined;  // .gpx → "com.topografix.gpx", .kml → "com.google.earth.kml"
export function safeExportName(filename: string): string;       // last path segment; characters outside [A-Za-z0-9._-] → "_"; "export" if nothing but dots is left
// utiFor and safeExportName live in src/bridge/exportFile.ts. The name comes from the page, where upstream code runs,
// so it must never be able to point outside the exports folder.
export function shareExport(file: { filename: string; mime: string; text: string }): Promise<void>;
// shareExport: writes Paths.cache/exports/<safeExportName(filename)>, then
//   Sharing.shareAsync(uri, { mimeType: mime, UTI: utiFor(filename), dialogTitle: filename })
export function releaseSource(uri: string): Promise<void>;
// releaseSource: deletes the file only when
//   isDisposableCopy(uri, { cache: Paths.cache.uri, inbox: `${Paths.document.uri}Inbox/` })
export function WebShell(): React.JSX.Element;
```

`share-mime.json` holds the `SHARE_MIME` array from the findings. `app.config.ts` reads the same file in Task 13.

**WebShell wiring** (§3.2):
- **State:**
  - `key` state; `remount()` increments it.
  - One controller, built once with `useRef`. `start()` is called on mount.
- **Controller dependencies:**

  | Dependency | Implementation |
  |---|---|
  | `confirmReplace`, `confirmClear` | `Alert.alert` with the `COPY` strings, resolving true for "Replace" / "Clear" |
  | `notify` | `ToastAndroid.show(text, ToastAndroid.SHORT)` on Android; `Alert.alert(text)` on iOS |
  | `exitApp` | `BackHandler.exitApp()` |
  | `openAbout` | `router.push("/about")` |
  | `openExternal` | `Linking.openURL` |
  | `send` | `webViewRef.current?.postMessage(encode(msg))` |
  | `chunkBytes` | `CHUNK_BYTES` |

- **WebView props:**
  - `source={{ html: WEB_HTML, baseUrl: ORIGIN }}`.
  - `originWhitelist={["*"]}`, so every URL reaches `onShouldStartLoadWithRequest` instead of unlisted schemes going straight to the OS.
  - `onShouldStartLoadWithRequest`:
    - Decide with `decideNavigation(url, initialLoadDone.current)`.
    - For `"external"`, call `Linking.openURL(url)`.
    - Return `decision === "allow"`.
    - `initialLoadDone` is a ref, set in `onLoadEnd` and cleared on every remount.
  - `onOpenWindow`: open http(s) URLs with `Linking.openURL`.
  - `onMessage`:
    - Drop the message unless `isTrustedSource(nativeEvent.url)`.
    - Parse it with `parseWebToNative`. If it's invalid, `console.warn` and drop it.
    - Otherwise, call `controller.onWebMessage`.
  - `applicationNameForUserAgent={`CrossTheFog/${Constants.expoConfig?.version} (+https://madera.codes)`}`.
  - `onContentProcessDidTerminate` and `onRenderProcessGone` call `controller.onProcessGone()`.
  - Also: `domStorageEnabled`, `allowFileAccess={false}`, `allowsBackForwardNavigationGestures={false}`, `webviewDebuggingEnabled={__DEV__}`.
  - Leave `setSupportMultipleWindows` at its default; `onOpenWindow` needs it.
- **Layout and events:**
  - Android draws edge to edge, which is Expo's default since SDK 54 (§4).
  - Wrap the WebView in react-native-safe-area-context's `SafeAreaView` (all edges), so the page stays clear of the system bars. Use the page's body background colour.
  - `BackHandler` `hardwareBackPress` calls `controller.onBackPressed()` and returns true.
  - An effect subscribes `controller.onIncoming` to `subscribeIncoming`.
- **Routes:**
  - `_layout.tsx`: a `Stack` with `index` (no header) and `about` (`presentation: "modal"`, title "About").
  - `index.tsx`: renders `WebShell`.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  ["fogtomaps-route.gpx", "com.topografix.gpx"],
  ["fogtomaps-route.kml", "com.google.earth.kml"],
  ["notes.txt", undefined],
])("utiFor(%s) is %s", (name, uti) => expect(utiFor(name)).toBe(uti));
it.each([
  ["fogtomaps-route.gpx", "fogtomaps-route.gpx"],
  ["../../Documents/fog/current-000001.json", "current-000001.json"],
  ["a b?.kml", "a_b_.kml"],
  ["..", "export"],
  ["dir/", "export"],
])("safeExportName(%j) is %j", (name, safe) => expect(safeExportName(name)).toBe(safe));
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm exec vitest run --project unit test/unit/exportFile.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `exportFile.ts`, then run the tests again**

Expected: PASS

- [ ] **Step 4: Install modules and implement the shell**

```bash
cd mobile
pnpm exec expo install react-native-webview expo-file-system expo-crypto expo-document-picker expo-sharing
```

Implement the platform files, `nativeHandlers.ts`, `WebShell.tsx` and the routes.

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: exit 0

- [ ] **Step 5: Run on the owner's phones**

Build and install, then copy the fixtures to the phone:

```bash
cd mobile && pnpm fixture
pnpm android --device
pnpm ios --device
adb push test/fixtures/out/*.zip /sdcard/Download/
```

On iOS, send the zips to Files with AirDrop.

Write the checklist below into `docs/manual-checklist.md` under "Native shell", with a result column. Then go through it with the owner:

1. **First launch:**
   - The brand reads "CROSS THE FOG".
   - There's no "Pick your Sync folder…" button.
   - defog's "Your fog is read on your device and is never uploaded." shows.
   - Nothing sits under the status bar, the notch or the navigation bar.
2. **Picker:** "…or a .zip" opens the system picker, never the WebView's chooser.
3. **Import:** picking `standard.zip` shows "2 tiles loaded ✓" and "Saved backup standard.zip, imported ‹today›".
4. **Restart:** force-quit and relaunch. The same fog and line show without picking anything.
5. **Bad import:** Update → `not-a-backup.zip` shows "That file isn't a Fog of World backup. Your saved fog is unchanged.", and "2 tiles loaded ✓" comes back.
6. **Non-zip pick:** picking a photo shows "Cross the Fog can only import .zip backups."
7. **Large backup:**
   - Picking `large-50mb.zip` shows "Loading your fog… ‹n› / 50 MB", then loads.
   - A relaunch loads it again from the cache.
8. **Export:**
   - Draw a route. GPX and KML open the share sheet with `fogtomaps-route.gpx` / `.kml`.
   - Cancelling the sheet shows nothing.
9. **External links:** "Maps ↗" and the Drive and OneDrive help links open outside the app.
10. **Android back:**
    - With the sheet open, back closes it.
    - With the sheet closed, back shows "Press back again to exit", and two presses within 2 s exit.
11. **Clear:**
    - "Clear saved fog" asks "Clear saved fog?". Choosing Clear brings back defog's first-run text.
    - A relaunch restores nothing.
12. **Real backup:** the owner's own multi-MB backup (never committed) loads, and a relaunch restores it.
13. **User agent:** in `chrome://inspect` and Safari Web Inspector, a tile request's User-Agent ends with "CrossTheFog/0.1.0 (+https://madera.codes)".
14. **Process death (Android emulator only):**
    - Run `adb root`, then `kill -9` the WebView's `sandboxed_process` during a large restore, twice.
    - The retry panel shows "Your saved fog couldn't be opened. The last attempt ran out of memory."
    - On iOS this can't be triggered by hand; the unit tests cover it.

Fix what fails, then record the results.

- [ ] **Step 6: Commit**

```bash
git add mobile
git commit -m "feat(mobile): native shell with WebView, picker, export and back"
```

---

### Task 13: Share-to-app

**Files:**
- Create: `mobile/app/+native-intent.ts`, `mobile/src/ShareIntentBridge.tsx`
- Modify: `mobile/app.config.ts`, `mobile/app/_layout.tsx`, `mobile/docs/manual-checklist.md`
- Test: `mobile/test/unit/nativeIntent.test.ts`

**Interfaces:**
- Consumes:
  - From Task 11: `fileFromSystemPath`, `filesFromShareIntent`, `enqueueIncoming`.
  - From Task 12: `share-mime.json`.
  - From Task 1: `IOS_OPEN_IN`.
- Produces:

```ts
export function redirectSystemPath(args: { path: string; initial: boolean }): string; // app/+native-intent.ts
export function ShareIntentBridge(): null;                                            // src/ShareIntentBridge.tsx
```

Install: `pnpm exec expo install expo-share-intent`.

Config (§3.8, D14):

```ts
ios: {
  bundleIdentifier: "codes.madera.crossfog",
  infoPlist: {
    CFBundleDocumentTypes: [{
      CFBundleTypeName: "Zip archive",
      CFBundleTypeRole: "Viewer",
      LSHandlerRank: "Alternate",
      LSItemContentTypes: ["public.zip-archive"],
    }],
    LSSupportsOpeningDocumentsInPlace: false,
  },
},
plugins: ["expo-router", ["expo-share-intent", { disableIOS: true, androidIntentFilters: shareMime }]],
// shareMime is imported from ./src/import/share-mime.json
```

**`redirectSystemPath`:**
1. If `path` contains `dataUrl=${getShareExtensionKey()}`, return `"/"`. The provider handles Android shares.
2. Otherwise, if `fileFromSystemPath(path)` returns a file, `enqueueIncoming` it and return `"/"`.
3. Otherwise, return `path` unchanged.
4. Any exception returns `"/"`.

**Layout:** `_layout.tsx` wraps the `Stack` in `ShareIntentProvider` and renders `<ShareIntentBridge />`.

**`ShareIntentBridge`:** when `useShareIntentContext()` reports a share, it:
1. maps `shareIntent.files` through `filesFromShareIntent`;
2. enqueues each file;
3. calls `resetShareIntent()`.

- [ ] **Step 1: Write the failing tests**

```ts
vi.mock("expo-share-intent", () => ({ getShareExtensionKey: () => "crossfogShareKey" }));
// queued: files received through subscribeIncoming
it("queues a file opened from another app and goes home", () => {
  expect(redirectSystemPath({ path: "file:///x/Documents/Inbox/fog.zip", initial: true })).toBe("/");
  expect(queued).toEqual([{ uri: "file:///x/Documents/Inbox/fog.zip", name: "fog.zip" }]);
});
it("leaves shares to the share-intent provider", () => {
  expect(redirectSystemPath({ path: "crossfog://dataUrl=crossfogShareKey", initial: false })).toBe("/");
  expect(queued).toEqual([]);
});
it("leaves other links alone", () =>
  expect(redirectSystemPath({ path: "/about", initial: false })).toBe("/about"));
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm exec vitest run --project unit test/unit/nativeIntent.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement, then run the tests again**

Expected: PASS

- [ ] **Step 4: Rebuild with the new native config and test on the phones**

Run: `cd mobile && pnpm exec expo prebuild --clean`, then rebuild both apps as in Task 12.

Add a "Share-to-app" section to the checklist and go through it:

1. **From Files to the app:**
   - Share `standard.zip` from Files to Cross the Fog.
   - With nothing saved, it imports.
   - With a saved fog, it asks "Replace your saved fog with standard.zip?". Replace imports; Cancel changes nothing.
2. **Other apps:** the same from Google Drive and Dropbox, on both platforms.
3. **App state:** it works with the app closed (cold start) and open (warm).
4. **Non-zip shares:** a non-zip file that Android offers to the app (sent as `application/octet-stream`) shows "Cross the Fog can only import .zip backups."
5. **iOS cleanup:** after an import, the app's `Documents/Inbox` is empty. Check by downloading the container in Xcode → Devices.

**iOS import scope:** iOS import is "Open With" from the Files app (`CFBundleDocumentTypes`) only. The iOS share sheet is out of scope for this MVP. `disableIOS: true` on expo-share-intent stays permanent for this version. If `IOS_OPEN_IN` from the spike is `fail`, **stop and ask the owner** before proceeding.

**Fallbacks:**
- If iOS file URLs never reach `redirectSystemPath`, also feed `fileFromSystemPath` from `Linking.getInitialURL()` and `Linking.addEventListener("url")` inside `ShareIntentBridge`, and note this in the checklist.

- [ ] **Step 5: Commit**

```bash
git add mobile
git commit -m "feat(mobile): share-to-app for .zip backups on iOS and Android"
```

---

### Task 14: About screen and licenses

**Files:**
- Create: `mobile/scripts/licenses.ts`, `mobile/licenses/leaflet-LICENSE.txt`, `mobile/licenses/pako-LICENSE.txt`
- Modify:
  - `mobile/app/about.tsx`
  - `mobile/package.json`: add the script `licenses`: `tsx scripts/licenses.ts`, and make `generate` run it after the web build.
- Test: `mobile/test/unit/licenses.test.ts`

**Interfaces:**
- Produces:

```ts
export interface LicenseEntry { name: string; version: string; license: string }
export function parsePnpmLicenses(json: string): LicenseEntry[]; // one entry per name and version, sorted by name
// CLI: writes generated/licenses.json = { defog: string; leaflet: string; pako: string; dependencies: LicenseEntry[] }
// from ../LICENSE, licenses/*.txt and `pnpm licenses list --prod --json`
```

Fetch the vendored libraries' license texts once, and commit them. First check the versions in the headers of `app/vendor/leaflet.js` and `app/vendor/pako_inflate.min.js` (1.9.4 and 2.1.0):

```bash
gh api "repos/Leaflet/Leaflet/contents/LICENSE?ref=v1.9.4" --jq .content | base64 -d > mobile/licenses/leaflet-LICENSE.txt
gh api "repos/nodeca/pako/contents/LICENSE?ref=2.1.0" --jq .content | base64 -d > mobile/licenses/pako-LICENSE.txt
```

**About screen** (§3.9), from top to bottom:
1. "Cross the Fog ‹version›", from `Constants.expoConfig.version`.
2. "Cross the Fog is based on defog by szalapak", linking to https://github.com/szalapak/defog, followed by the full MIT notice.
3. "Leaflet (BSD-2-Clause)" and "pako (MIT and Zlib)", each followed by its license text.
4. "Map data © OpenStreetMap contributors, ODbL", linking to https://www.openstreetmap.org/copyright.
5. "Open-source licenses", with one row per dependency: "‹name› ‹version› · ‹license›".

Links open with `Linking.openURL`.

- [ ] **Step 1: Write the failing tests**

Run `pnpm licenses list --prod --json` once and make the sample below match its real shape.

```ts
const sample = JSON.stringify({
  MIT: [
    { name: "zod", versions: ["4.1.0"], license: "MIT" },
    { name: "expo", versions: ["57.0.1"], license: "MIT" },
  ],
  "0BSD": [{ name: "tslib", versions: ["2.6.0", "2.8.1"], license: "0BSD" }],
});
it("flattens, splits versions and sorts by name", () =>
  expect(parsePnpmLicenses(sample)).toEqual([
    { name: "expo", version: "57.0.1", license: "MIT" },
    { name: "tslib", version: "2.6.0", license: "0BSD" },
    { name: "tslib", version: "2.8.1", license: "0BSD" },
    { name: "zod", version: "4.1.0", license: "MIT" },
  ]));
it("rejects output it doesn't recognise", () => expect(() => parsePnpmLicenses("[]")).toThrow());
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd mobile && pnpm exec vitest run --project unit test/unit/licenses.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement, then run the tests and the generator**

```bash
cd mobile
pnpm exec vitest run --project unit test/unit/licenses.test.ts   # Expected: PASS
pnpm generate                                                    # Expected: also writes generated/licenses.json
```

- [ ] **Step 4: Build `about.tsx` and check it on a phone**

Expected: About opens as a modal and shows the defog credit, the three notices and the dependency list.

- [ ] **Step 5: Commit**

```bash
git add mobile/scripts/licenses.ts mobile/licenses mobile/app/about.tsx mobile/test/unit/licenses.test.ts mobile/package.json
git commit -m "feat(mobile): About screen with credits and licenses"
```

---

### Task 15: Store baseline

**Files:**
- Create: `mobile/eas.json`, `mobile/scripts/privacy-union.ts`, `mobile/scripts/check-apk.sh`
- Modify: `mobile/app.config.ts` (`ios.privacyManifests`), `mobile/docs/manual-checklist.md`
- Copy from (read only): `/Users/leo/Lab/chase-cashew/apps/mobile/eas.json`

**Interfaces:**
- Produces:
  - `scripts/check-apk.sh <apk>`: prints `OK <check>` for each check, or exits 1 naming the check that failed.
  - `scripts/privacy-union.ts`: prints a `privacyManifests` object to paste into `app.config.ts`.
  - EAS profile `e2e`, used by Task 16.

**`eas.json`:** chase-cashew's profiles, plus `e2e`:

| Profile | Settings |
|---|---|
| `development` | `developmentClient`, internal distribution, APK |
| `preview` | internal distribution, APK |
| `production` | `autoIncrement`, app bundle |
| `e2e` | `"extends": "preview"`, `"env": { "CROSSFOG_E2E": "1" }` |

Also set `cli.appVersionSource: "remote"`.

Under `build.production`, add `"android": { "ndk": "27" }` to pin NDK r27+. This is required for 16 KB-aligned ELF LOAD segments; earlier NDK versions produce `.so` files that crash silently on Pixel 9 and API 35+ devices.

**`check-apk.sh`** uses the newest `$ANDROID_HOME/build-tools/*` and the NDK's `llvm-readelf`. It checks (§4):
1. **Permissions:** the `android.permission.*` entries from `aapt2 dump permissions` are exactly `android.permission.INTERNET`. App-defined permissions are ignored.
2. **Target SDK:** `aapt2 dump badging` shows `targetSdkVersion:'36'`.
3. **Zip alignment:** `zipalign -c -P 16 -v 4` passes.
4. **16 KB pages:** every `LOAD` segment of every `lib/arm64-v8a/*.so` and `lib/x86_64/*.so` has an alignment of at least `0x4000` (`llvm-readelf -lW`).

**`privacy-union.ts`:**
1. Run it after `pnpm exec expo prebuild -p ios --clean` and `pod install` in `ios/`.
2. It reads every `ios/Pods/**/PrivacyInfo.xcprivacy` with `plutil -convert json -o -`.
3. It prints the union of their `NSPrivacyAccessedAPITypes` with their reasons.
4. Declare every category it prints, plus any category that Expo's Apple privacy guide lists for the modules used (§4).

- [ ] **Step 1: Write `eas.json` and both scripts**

- [ ] **Step 2: Check an Android release build**

```bash
cd mobile
pnpm generate
pnpm exec expo prebuild -p android --clean
(cd android && ./gradlew assembleRelease)
scripts/check-apk.sh android/app/build/outputs/apk/release/app-release.apk
```

Expected: `OK permissions`, `OK targetSdk`, `OK zipalign`, `OK 16k-elf`.

If the permissions check finds an extra permission:
- If nothing needs it at runtime, add it to `blockedPermissions` and rebuild.
- If a module needs it, **stop and ask the owner**.

- [ ] **Step 3: iOS privacy manifest and Xcode**

```bash
xcodebuild -version   # Expected: Xcode 26.x
cd mobile && pnpm exec expo prebuild -p ios --clean && (cd ios && pod install) && pnpm exec tsx scripts/privacy-union.ts
```

1. Paste the output into `ios.privacyManifests` in `app.config.ts`.
2. Run `pnpm exec expo prebuild -p ios --clean` again, and confirm that the generated `PrivacyInfo.xcprivacy` lists the categories.
3. Run `pnpm exec expo run:ios --configuration Release --device`. Expected: the app starts and restores the saved fog.

- [ ] **Step 4: EAS preview build**

The owner runs `pnpm exec eas login` and `pnpm exec eas init`. `eas init` prints the project ID, which goes into `app.config.ts` as `extra.eas.projectId`.

Then run `pnpm exec eas build -p android --profile preview`. Expected: a download link. Run `scripts/check-apk.sh` on that APK as well.

- [ ] **Step 5: Record and commit**

Add the results to the checklist under "Store baseline", then commit:

```bash
git add mobile/eas.json mobile/scripts mobile/app.config.ts mobile/docs/manual-checklist.md
git commit -m "chore(mobile): store baseline checks, privacy manifest and EAS profiles"
```

---

### Task 16: End-to-end flows, docs and final verification

**Files:**
- Create:
  - `mobile/src/e2e/fixturePicker.ts`, `mobile/metro.config.js`
  - `mobile/assets/e2e/standard.zip`, `mobile/assets/e2e/not-a-backup.zip`
  - `mobile/.maestro/config.yaml` and the flows below
  - `mobile/README.md`
- Modify:
  - `mobile/app.config.ts` (`extra.e2e`)
  - `mobile/src/WebShell.tsx` (which picker it uses)
  - `mobile/package.json`: `verify` gains `&& pnpm knip`; add the script `e2e`: `maestro test .maestro`
  - `mobile/test/unit/fixtures.test.ts`, `mobile/docs/manual-checklist.md`

**Interfaces:**
- Consumes: `SourceFile` (Task 10), `standardBackup` and `notABackup` (Task 4).
- Produces: `pickE2eFixture(): Promise<SourceFile | null>`.
  - It shows an `Alert` with "Standard backup", "Not a backup" and "Cancel".
  - It resolves the chosen bundled asset to a local file with expo-asset (`Asset.fromModule(require(…)).downloadAsync()`).
  - It returns `{ uri, name }`, where `name` is `"standard.zip"` or `"not-a-backup.zip"`.

- [ ] **Step 1: Commit the fixtures and pin them with a test**

1. Run `pnpm fixture`.
2. Copy `standard.zip` and `not-a-backup.zip` from `test/fixtures/out/` to `assets/e2e/`.
3. Add this test to `fixtures.test.ts`:

```ts
it("the committed e2e fixtures match the generator", () => {
  expect(new Uint8Array(readFileSync("assets/e2e/standard.zip"))).toEqual(standardBackup());
  expect(new Uint8Array(readFileSync("assets/e2e/not-a-backup.zip"))).toEqual(notABackup());
});
```

Run: `cd mobile && pnpm exec vitest run --project unit test/unit/fixtures.test.ts`
Expected: PASS

- [ ] **Step 2: Wire up the e2e build**

- `metro.config.js`: Expo's default config, with `"zip"` added to `resolver.assetExts`.
- `app.config.ts`: `extra: { e2e: process.env.CROSSFOG_E2E === "1" }`. Keep `extra.eas` from Task 15.
- `WebShell`: use `pickE2eFixture` when `Constants.expoConfig?.extra?.e2e` is true. `build-web.ts` already turns on the dev tools for `CROSSFOG_E2E=1`.

Install expo-asset with `pnpm exec expo install expo-asset`.

- [ ] **Step 3: Write the Maestro flows**

Every flow uses `appId: codes.madera.crossfog`. `config.yaml` runs them in this order:

1. **`import.yaml`:**
   - `launchApp` with `clearState: true`.
   - Tap "…or a .zip", then "Standard backup".
   - Assert "2 tiles loaded ✓" and "Saved backup standard.zip.*" are visible.
2. **`restart.yaml`:** `stopApp`, `launchApp`, then assert "2 tiles loaded ✓".
3. **`eviction.yaml`:** tap "Dev: drop fog cache", `stopApp`, `launchApp`, then assert "2 tiles loaded ✓".
4. **`not-a-backup.yaml`:**
   - Tap "Update", then "Not a backup".
   - Assert "That file isn't a Fog of World backup. Your saved fog is unchanged." and "2 tiles loaded ✓" are visible.
5. **`export.yaml`** (needs network for BRouter):
   - Tap "Plan", then "Start drawing", then two map points.
   - Wait until "GPX" is enabled, then tap it.
   - Assert "fogtomaps-route.gpx" is visible in the share sheet.
6. **`about.yaml`:** tap "About", then assert "Cross the Fog is based on defog by szalapak".

- [ ] **Step 4: Run the flows on both platforms**

Maestro drives iOS simulators, not physical iPhones. The `android` and `ios` scripts run `generate` first, so the dev tools are in the page.

```bash
cd mobile
CROSSFOG_E2E=1 pnpm android --variant release && pnpm e2e   # emulator or USB phone
CROSSFOG_E2E=1 pnpm ios && pnpm e2e                          # simulator
```

Expected: all six flows pass on both.

- [ ] **Step 5: Write the docs**

**`docs/manual-checklist.md`:** merge the Task 12, 13 and 15 sections with the manual list in §9.

**`README.md`:**
- What the app is.
- Setup: Node ≥ 26, pnpm 11, Xcode 26, the Android SDK and NDK, Maestro.
- The scripts.
- How the page is built (§3.1).
- How to run the e2e flows.
- The upstream merge procedure, the four steps of §9 word for word.
- The domain rules from D11:
  - Nothing is ever hosted at `crossfog.madera.codes`.
  - `madera.codes` never gets a wildcard DNS record.
  - The app's website lives at `madera.codes/crossfog`.

- [ ] **Step 6: Final verification**

If knip reports expo-router's peer packages (such as `expo-linking`, `expo-constants` or `react-native-screens`) as unused, list them in `knip.json`'s `ignoreDependencies`.

```bash
cd mobile
pnpm verify                # Expected: exit 0 (typecheck, lint, unit, adapter, contract, build:web, knip)
pnpm exec stryker run      # Expected: exit 0, mutation score ≥ 80
git status --short         # Expected: no android/, ios/, generated/ or reports/
```

- [ ] **Step 7: Commit**

```bash
git add mobile
git commit -m "test(mobile): Maestro flows, e2e fixtures and docs"
```

---

### Task 17: Link Sync folder (only where S5 passed)

**When to do it:**
- Skip this task on any platform whose `LINK_FOLDER` finding is `fail`. Skip it entirely if both failed (§7).
- S5 decides which native calls keep folder access, so first write a short addendum to this plan from the findings, and get the owner's OK.

**Files:**
- Modify:
  - `mobile/src/bridge/protocol.ts`, `mobile/src/fog/store.ts`, `mobile/src/controller.ts`
  - `mobile/web-adapter/session.ts`, `mobile/web-adapter/loader.ts`, `mobile/web-adapter/status.ts`
- Create: `mobile/src/fog/folderLink.ts`
- Test: next to each changed module.

**Interfaces** (additions):

```ts
// protocol.ts
// restore gains kind: "zip" | "folder"; every existing sender sets "zip"
// chunk gains file?: string, naming the file in a folder transfer
// WebToNative gains { v: 1; type: "linkFolder" }
// folderLink.ts
export function folderFingerprint(
  files: Array<{ name: string; size: number; modified: number }>,
  sha256Hex: (bytes: Uint8Array) => Promise<string>,
): Promise<string>; // SHA-256 of the sorted lines "name\tsize\tmodified\n"
```

**Behaviour:**
- **Linking:** "Link Sync folder" in the saved-fog line sends `linkFolder`. Native opens the folder picker, keeps access the way S5 found works, and stores the link beside the fog files.
- **At launch:** a linked folder comes before the saved zip.
  1. Native lists the folder and computes `folderFingerprint`.
  2. Native sends `restore` with `kind: "folder"`.
  3. On a cache miss, native streams every file with its name.
  4. The adapter assigns the files to `#folder` and fires `change`.
- **Outcome:** defog reads folder files in `loadFromInput`, which calls `pako.inflate` once per file.
  - The loader wraps `pako.inflate` and counts calls in a `finally`.
  - When the count reaches the number of files assigned, it uses the same zero-delay timer and tile count as for zips.
- **Unreachable folder:** restore the cached copy if there is one, and show the notice "Couldn't reach your Sync folder. Showing fog from ‹date›." (§8).

**Tests:**
- `folderFingerprint` ignores file order, and changes when a size or a modification time changes.
- The protocol round-trips the new fields.
- The loader reports ok, with the tile count, for a folder holding the standard tiles.
- The controller sends `kind: "folder"` when a folder is linked.
- When the folder can't be listed, the controller falls back and shows the notice.

Steps follow the same pattern as Tasks 10 and 11: failing tests, implementation, passing tests, a Stryker run on the changed files, a device check, and a commit:

```bash
git commit -m "feat(mobile): link a Sync folder where the platform keeps access"
```

---

## Execution Handoff

Council review complete (2026-10-01). Conditional Go conditions resolved. Choose an execution method and tell the implementer which to use:

- **Subagent-driven** (`superpowers:subagent-driven-development`): a fresh subagent per task, independent reviewer before the next task, whole-branch review at the end.
- **Native** (`superpowers:executing-plans`): one session implements all tasks, one reviewer checks the whole branch at the end.

Recommended: subagent-driven. The fog store and controller share interfaces that, if wrong, corrupt a user's saved fog; per-task reviews catch that before later tasks build on it.
