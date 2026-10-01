# Manual checklist

## Native shell

| # | Step | Result |
|---|------|--------|
| 1 | **First launch:** brand reads "CROSS THE FOG"; no "Pick your Sync folder…" button; defog's "Your fog is read on your device and is never uploaded." shows; nothing sits under status bar, notch, or nav bar | |
| 2 | **Picker:** "…or a .zip" opens the system picker, never the WebView's chooser | |
| 3 | **Import:** picking `standard.zip` shows "2 tiles loaded ✓" and "Saved backup standard.zip, imported ‹today›" | |
| 4 | **Restart:** force-quit and relaunch; the same fog and line show without picking anything | |
| 5 | **Bad import:** Update → `not-a-backup.zip` shows "That file isn't a Fog of World backup. Your saved fog is unchanged." and "2 tiles loaded ✓" comes back | |
| 6 | **Non-zip pick:** picking a photo shows "Cross the Fog can only import .zip backups." | |
| 7a | **Large backup:** picking `large-50mb.zip` shows "Loading your fog… ‹n› / 50 MB", then loads | |
| 7b | **Large backup restart:** a relaunch loads it again from the cache | |
| 8 | **Export:** draw a route; GPX and KML open the share sheet with `fogtomaps-route.gpx` / `.kml`; cancelling the sheet shows nothing | |
| 9 | **External links:** "Maps ↗" and the Drive and OneDrive help links open outside the app | |
| 10a | **Android back (sheet open):** back closes the sheet | |
| 10b | **Android back (sheet closed):** back shows "Press back again to exit"; two presses within 2 s exit | |
| 11a | **Clear:** "Clear saved fog" asks "Clear saved fog?"; choosing Clear brings back defog's first-run text | |
| 11b | **Clear restart:** a relaunch restores nothing | |
| 12 | **Real backup:** owner's own multi-MB backup loads; a relaunch restores it | |
| 13 | **User agent:** in `chrome://inspect` / Safari Web Inspector a tile request's User-Agent ends with `CrossTheFog/0.1.0 (+https://madera.codes)` | |
| 14 | **Process death (Android emulator only):** `adb root` + `kill -9` sandboxed_process during large restore (twice); retry panel shows "Your saved fog couldn't be opened. The last attempt ran out of memory." | |
