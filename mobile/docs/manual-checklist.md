# Manual checklist

## Native shell

| # | Step | Result |
|---|------|--------|
| 1 | **First launch:** brand reads "CROSS THE FOG"; no "Pick your Sync folder…" button; defog's "Your fog is read on your device and is never uploaded." shows; nothing sits under status bar, notch, or nav bar | ✓ |
| 2 | **Picker:** "…or a .zip" opens the system picker, never the WebView's chooser | ✓ |
| 3 | **Import:** picking `standard.zip` shows "2 tiles loaded ✓" and "Saved backup standard.zip, imported ‹today›" | ✓ |
| 4 | **Restart:** force-quit and relaunch; the same fog and line show without picking anything | ✓ |
| 5 | **Bad import:** Update → `not-a-backup.zip` shows "That file isn't a Fog of World backup. Your saved fog is unchanged." and "2 tiles loaded ✓" comes back | ✓ |
| 6 | **Non-zip pick:** picking a photo shows "Cross the Fog can only import .zip backups." | ✓ |
| 7a | **Large backup:** picking `large-50mb.zip` shows "Loading your fog… ‹n› / 50 MB", then loads | ✓ |
| 7b | **Large backup restart:** a relaunch loads it again from the cache | ✓ |
| 8 | **Export:** draw a route; GPX and KML open the share sheet with `fogtomaps-route.gpx` / `.kml`; cancelling the sheet shows nothing | ✓ |
| 9 | **External links:** "Maps ↗" and the Drive and OneDrive help links open outside the app | ✓ |
| 10a | **Android back (sheet open):** back closes the sheet | ✓ |
| 10b | **Android back (sheet closed):** back shows "Press back again to exit"; two presses within 2 s exit | ✓ |
| 11a | **Clear:** "Clear saved fog" asks "Clear saved fog?"; choosing Clear brings back defog's first-run text | ✓ |
| 11b | **Clear restart:** a relaunch restores nothing | ✓ |
| 12 | **Real backup:** owner's own multi-MB backup loads; a relaunch restores it | ✓ (Sync.zip — 246 tiles, 0.00014% defogged) |
| 13 | **User agent:** in `chrome://inspect` / Safari Web Inspector a tile request's User-Agent ends with `CrossTheFog/0.1.0 (+https://madera.codes)` | ✓ |
| 14 | **Process death (Android emulator only):** `adb root` + `kill -9` sandboxed_process during large restore (twice); retry panel shows "Your saved fog couldn't be opened. The last attempt ran out of memory." | ✓ |

## Share-to-app

| # | Step | Result |
|---|------|--------|
| S1a | **From Files (nothing saved):** share `standard.zip` from Files to Cross the Fog; imports immediately | |
| S1b | **From Files (saved fog):** share `standard.zip` again; app asks "Replace your saved fog with standard.zip?"; Replace imports; Cancel changes nothing | |
| S2 | **Other apps:** same flow from Google Drive and Dropbox, on both platforms | |
| S3a | **Cold start:** share a zip with the app closed; app opens and imports | |
| S3b | **Warm start:** share a zip with the app open; imports without relaunching | |
| S4 | **Non-zip share:** a non-zip offered as `application/octet-stream` shows "Cross the Fog can only import .zip backups." | |
| S5 | **iOS cleanup:** after an import, app's `Documents/Inbox` is empty (verify in Xcode → Devices → container) | |

## About screen

| # | Step | Result |
|---|------|--------|
| A1 | **Open:** tap About (modal); version number is `0.1.0` (hardcoded in `about.tsx` — confirm it matches the `version` field in `package.json`); app name shows correctly | ✓ |
| A2 | **defog credit:** szalapak credit and MIT licence text visible | ✓ |
| A3 | **Map tiles:** OpenStreetMap attribution and ODbL reference visible | ✓ |
| A4 | **Leaflet / pako:** BSD-2 and MIT licence blocks visible | ✓ |
| A5 | **Dep list:** scrollable table shows ≥ 500 rows; name, version and SPDX identifier columns | ✓ (560 rows) |

## Store baseline

| # | Step | Result |
|---|------|--------|
| B1 | **Permissions:** `check-apk.sh` prints `OK permissions` (only `INTERNET`) | ✓ |
| B2 | **Target SDK:** `check-apk.sh` prints `OK targetSdk` (36) | ✓ |
| B3 | **Zip alignment:** `check-apk.sh` prints `OK zipalign` | ✓ |
| B4 | **16 KB ELF pages:** `check-apk.sh` prints `OK 16k-elf` on API 35+ device or AVD | ✓ |
| B5 | **iOS privacy manifest:** `privacy-union.ts` output pasted into `app.config.ts`; generated `PrivacyInfo.xcprivacy` lists all categories | ✓ |
| B6 | **EAS preview APK:** `eas build -p android --profile preview` produces a download link; `check-apk.sh` passes on that APK | ✓ |

## Maestro e2e flows

Run with `CROSSFOG_E2E=1 pnpm android` (or `ios`) to build, then `pnpm e2e`.

| Flow | Expected |
|------|----------|
| import | "2 tiles loaded ✓" and "Saved backup standard.zip" after picking Standard backup |
| restart | "2 tiles loaded ✓" on cold start |
| eviction | "2 tiles loaded ✓" after dropping the cache and restarting |
| not-a-backup | "That file isn't a Fog of World backup." stays visible |
| export | "fogtomaps-route.gpx" visible in the share sheet |
| about | "Cross the Fog is based on defog by szalapak" visible |
