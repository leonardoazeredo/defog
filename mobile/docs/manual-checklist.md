# Manual checklist

_Run every row on Android only. iOS is paused until the Android phone app and the Wear OS app are done, tested and released; the iOS results below are from earlier runs._

## Native shell

_Latest re-run: Android emulator (API 36, userdebug image). Results marked iOS come from an earlier iOS simulator run (iPhone 17, iOS 27.0); a plain ✓ means Android passed._

| # | Step | Result |
|---|------|--------|
| 1 | **First launch:** brand reads "CROSS THE FOG"; no "Pick your Sync folder…" button; defog's "Your fog is read on your device and is never uploaded." shows; nothing sits under status bar, notch, or nav bar | ✓ |
| 2 | **Picker:** "…or a .zip" opens the system picker, never the WebView's chooser | ✓ |
| 3 | **Import:** picking `standard.zip` shows "2 tiles loaded ✓" and "Saved backup standard.zip, imported ‹today›" | ✓ |
| 4 | **Restart:** force-quit and relaunch; the same fog and line show without picking anything | ✓ |
| 5 | **Bad import:** Update → `not-a-backup.zip` shows "That file isn't a Fog of World backup. Your saved fog is unchanged." and "2 tiles loaded ✓" comes back | ✓ |
| 6 | **Non-zip pick:** picking a photo shows "Cross the Fog can only import .zip backups." | ✓ (iOS). Android: not doable as written, because the picker greys out non-zips; the message is reached through a share instead (S4) |
| 7a | **Large backup:** picking `large-50mb.zip` shows "Loading your fog… ‹n› / 50 MB", then loads | ✓ (Android). The web view remounts and the panel collapses, and that line sits in the panel body, so it is off-screen while it shows (the text is asserted in `test/adapter/status.test.ts`). The same progress is also shown where it stays visible: the header reads "Loading… N / 50 MB" and moves (14-17 distinct values on the iOS simulator, no stall over about 1 s), and a static "Importing your fog…" card sits over the page during the import, clearing when the fog has loaded, after a bad backup, and after a cancelled picker. The card is deliberately not animated: an animated spinner made the Android emulator repaint continuously and slowed the import from about 40 s to about 150 s. The streaming loop yields every 4th chunk so the header can update. Measured on the simulator (Release build, two runs each): with the JavaScript SHA-256 a 50 MB share took about 25 s to the last chunk, of which the hash in `beginImport` was about 18 s (72-73%) with the web view frozen on the old page, the remount about 1 s, and base64 plus streaming about 6 s; the native copy and the file read were under 30 ms, and the whole import was about 30-35 s. With the native `expo-crypto` digest `beginImport` takes about 0.4 s and the fog is loaded about 8 s after the share; the stored fingerprint equals `shasum -a 256` of the file on iOS and Android. Android emulator (2.5 GB RAM, swapping): about 38-39 s from the picker tap before the import feedback, of which the picker copy plus `beginImport` is about 5 s and the remount, streaming and page parse about 33 s; about 46.5 s with the feedback (two runs), the extra 7-8 s being the frame-bound yields on a slow emulator |
| 7b | **Large backup restart:** a relaunch loads it again from the cache | ✓ |
| 8 | **Export:** draw a route; GPX and KML open the share sheet with `fogtomaps-route.gpx` / `.kml`; cancelling the sheet shows nothing | ✓ |
| 9 | **External links:** "Maps ↗" and the Drive and OneDrive help links open outside the app | ✓ (Android): onedrive.live.com hands off to Chrome, also on the first tap with the panel unscrolled now that the map attribution sits above the sheet; drive.google.com is claimed by the Drive app, which exits at once on an emulator with no Google account, so no browser opens for it. iOS: "Maps ↗" opens Safari, and the `help-links` Maestro flow leaves the app and returns for both Drive and OneDrive. The flow proves the app was left, not which page opened (onedrive.live.com redirects) |
| 10a | **Android back (sheet open):** back closes the sheet | ✓ (re-checked after the About fix) |
| 10b | **Android back (sheet closed):** back shows "Press back again to exit"; two presses within 2 s exit | ✓ (re-checked after the About fix, including after visiting About) |
| 11a | **Clear:** "Clear saved fog" asks "Clear saved fog?"; choosing Clear brings back defog's first-run text | ✓ |
| 11b | **Clear restart:** a relaunch restores nothing | ✓ |
| 12 | **Real backup:** owner's own multi-MB backup loads; a relaunch restores it | ✓ (Android: Sync.zip, 246 tiles; a relaunch restores it without picking). The percentage is for the visible map area, so it depends on the viewport: 0.00014% in the Android app (1080x2400), 0.00015% on the website at 390x844, 0.000067% at 1280x800 and 0.000029% at 1920x1080 |
| 13 | **User agent:** in `chrome://inspect` / Safari Web Inspector a tile request's User-Agent ends with `CrossTheFog/0.1.0 (+https://madera.codes)` | ✓ (Android: the page's `navigator.userAgent`, read over devtools, ends with it; a tile request's header was not inspected, and iOS was not run. No automated test asserts it) |
| 14 | **Process death (Android emulator only):** `adb root` + `kill -9` sandboxed_process during a large reload (twice); retry panel shows "Your saved fog couldn't be opened. The last attempt ran out of memory." | ✓ (Android, rooted emulator). `scripts/process-death-android.sh <serial>` kills the renderer twice during the reload and the panel shows exactly that text; Retry reloads the fog. A kill while idle and one right after "tiles loaded" recover silently with no panel. One kill alone recovers silently too, because the reload guard allows two attempts |

## Share-to-app

_Tested on: Android emulator (API 36): all rows except S2, which waits for the hardware pass (no cloud apps on the emulator). Earlier iOS simulator run (iPhone 17, iOS 27.0): S1a, S1b, S3a and S3b passed, with the share simulated by `xcrun simctl openurl file://…/standard.zip`._

| # | Step | Result |
|---|------|--------|
| S1a | **From Files (nothing saved):** share `standard.zip` from Files to Cross the Fog; imports immediately | ✓ |
| S1b | **From Files (saved fog):** share `standard.zip` again; app asks "Replace your saved fog with standard.zip?"; Replace imports; Cancel changes nothing | ✓ |
| S2 | **Other apps:** same flow from Google Drive and Dropbox | skip — no cloud apps on emulator |
| S3a | **Cold start:** share a zip with the app closed; app opens and imports | ✓ |
| S3b | **Warm start:** share a zip with the app open; imports without relaunching | ✓ |
| S4 | **Non-zip share:** a non-zip offered as `application/octet-stream` shows "Cross the Fog can only import .zip backups." | ✓ (Android). iOS: not reachable. The app only registers the zip document type, so iOS never offers a non-zip file to it |
| S5 | **Cleanup:** after an import, the app keeps no copy of the shared file in its cache | ✓ (Android: the cache copy is deleted after each import) |

## About screen

| # | Step | Result |
|---|------|--------|
| A1 | **Open:** tap About (modal); version number is `0.1.0` (hardcoded in `about.tsx` — confirm it matches the `version` field in `package.json`); app name shows correctly | ✓ |
| A2 | **defog credit:** szalapak credit and MIT licence text visible | ✓ |
| A3 | **Map tiles:** OpenStreetMap attribution and ODbL reference visible | ✓ |
| A4 | **Leaflet / pako:** BSD-2 and MIT licence blocks visible | ✓ |
| A5 | **Dep list:** scrollable list shows ≥ 500 rows; each row has name, version and SPDX identifier | ✓ (Android: the page says 561 packages, and the list scrolls alphabetically from @babel to zod; about 80 rows were read, the rest were not counted. `generated/licenses.json` had 561 at the time, and 562 once `expo-crypto` was added) |

| A6 | **Android back from About:** hardware back closes About and returns to the map; back on the main screen still closes the sheet and then asks to press again | ✓ (Android; the `about` Maestro flow presses Back) |

_A2–A6 were checked on Android._

## Store baseline

| # | Step | Result |
|---|------|--------|
| B1 | **Permissions:** `check-apk.sh` prints `OK permissions` (only `INTERNET`) | ✓ |
| B2 | **Target SDK:** `check-apk.sh` prints `OK targetSdk` (36) | ✓ |
| B3 | **Zip alignment:** `check-apk.sh` prints `OK zipalign` | ✓ |
| B4 | **16 KB ELF pages:** `check-apk.sh` prints `OK 16k-elf` (a static check of the APK, so it needs no device) | ✓ |
| B6 | **EAS preview APK:** `eas build -p android --profile preview` produces a download link; `check-apk.sh` passes on that APK | ✓ (B1–B4 also pass on a local release APK and on the existing preview build, which is from an older commit; no new cloud build was started) |

## Maestro e2e flows

Build a Release app (embedded JS bundle, no Metro): `CROSSFOG_E2E=1 pnpm generate`, then `CROSSFOG_E2E=1 npx expo run:android --variant release --device <avd>` (clear the Gradle release bundle first, as `mobile/CLAUDE.md` describes), then `pnpm e2e`. The flows share app state, so `.maestro/config.yaml` pins their order. Before the run, `adb push mobile/test/fixtures/history-walk-backup.db /sdcard/Download/` for `history-release`, which comes last because its restore replaces everything.

`history-release` is the regression check for #139 and must run on this Release build, because a debug build can hide a held native-to-page message. It restores the fixture backup, cold starts, opens the walk's card, and waits for "Show on map" to become enabled with no other tap. It then shows the walk on the map (the defog figure for that view is non-zero), deletes the walk, and expects "No activities yet" and "0%" for the same view. On a build without the fix it fails at the "Show on map" step.

To remake `history-walk-backup.db` (for example after a schema change), use a debug e2e build. Import `standard.zip`, add `glancemap-walk.gpx` with "Dev: add activity from GPX", then "Back up…" without a passphrase after the plaintext warning. Check the result with `sqlite3`: the `import` blob must hash to `test/fixtures/out/standard.zip`, there must be exactly one activity, and `page_settings` must hold no map position.

`history.yaml` is not in `config.yaml`. It needs the developer-only add-activity action, which exists only in a debug build. Build that with `CROSSFOG_E2E=1 pnpm android -- --device <avd>` (Metro serves the JS, so `adb reverse tcp:8081 tcp:8081`), `adb push mobile/test/fixtures/glancemap-walk.gpx /sdcard/Download/`, import `standard.zip`, then run `maestro test .maestro/history.yaml`. The debug build's launches are too slow for the other flows, and a tag that splits one config cannot be used: Maestro 2.11 refuses tag filters together with `flowsOrder`.

_history.yaml tested on: Android emulator API 36 (AVD `chase-cashew-test`), debug e2e build with Metro: passed._

_Tested on: Android emulator API 36 (AVD `chase-cashew-test`): 7/7 passed in 1m 59s. iOS simulator (iPhone 17, iOS 27.0): 7/7 passed in 2m 35s; an earlier iOS run failed once in `export`, which passed on the next run._

_On iOS the share sheet hides the `.gpx` extension and has no Back key, so `export` accepts either filename and dismisses the sheet by tapping outside it. `not-a-backup` retries opening the panel because a tap during the second remount can be lost._

_`help-links` expands the "Where's my Sync folder?" disclosure, swipes a fixed distance so the link is on screen (Maestro reports off-screen web view text as visible, so a "swipe only if not visible" guard is skipped), taps the link and asserts that "Expand or collapse panel" is gone, which is the only proof the app was left because the link text is also visible inside the app. iOS runs Drive then OneDrive; Android runs OneDrive only, because without a Google account the Drive app swallows the link and leaves the app in front._

| Flow | Expected | Result |
|------|----------|--------|
| import | "2 tiles loaded ✓" and "Update" after picking Standard backup | ✓ |
| restart | "2 tiles loaded ✓" on cold start | ✓ |
| eviction | "2 tiles loaded ✓" after dropping the cache and restarting | ✓ |
| not-a-backup | "That file isn't a Fog of World backup. Your saved fog is unchanged." stays visible | ✓ |
| export | The plaintext warning shows, Continue, then "fogtomaps-route.gpx" visible in the share sheet | ✓ |
| about | "Version 0.1.0" visible on the About screen; on Android, Back closes it | ✓ |
| help-links | Tapping each help link leaves the app, and the app is back afterwards | ✓ |
| history-release | After restoring the fixture backup and a cold start, the walk's track loads with no other input; delete leaves "No activities yet" and the defog figure at 0% for the same view | ✓ (Android, Release e2e build; fails at "Show on map" enabled without the fix) |
| history (debug build, run alone) | Dev add of the fixture activity shows the "47 steps" card, its track loads, and delete leaves "No activities yet" | ✓ |
