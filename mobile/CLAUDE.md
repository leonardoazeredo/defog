# Cross the Fog (Expo app)

Read `AGENTS.md` first: Expo APIs change every SDK, so fetch the versioned docs (`expo` is `~58`, `https://docs.expo.dev/versions/v58.0.0/`) before touching an Expo, EAS or React Native API.

Android only. iOS is paused until the Android phone app and the Wear OS app are done, tested and released: no iOS builds, simulator runs, fixes or plan items before then, and every check runs on Android. `AGENTS.md`'s iOS examples do not apply.

## Commands

- Unit tests: `pnpm test` (vitest, projects `unit` and `adapter`). One file: `npx vitest run test/unit/incoming.test.ts --reporter=dot`.
- Typecheck: `pnpm typecheck` (it runs `pnpm generate` first). Lint: `npx biome check <paths>`; existing warnings in `test/adapter/hooks.test.ts` are unrelated.
- Full gate: `pnpm verify`.
- Builds: use `pnpm android`; it regenerates the web bundle first. A raw `npx expo run:*` does not.
- Android builds need JDK 21 (`JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home`), `ANDROID_HOME=$HOME/Library/Android/sdk`, and `--device <AVD name>`, not the adb serial.
- e2e builds need `CROSSFOG_E2E=1` for the web build, the app config and the prebuild, and a Release configuration. Run Maestro against them with `maestro --device <serial> test .maestro`.
- Pull requests: `gh pr create --repo leonardoazeredo/defog --base main`.
- `modules/watch-link` (Kotlin local module, hand-written and committed, unlike the generated `mobile/android/`; Gradle runs in `mobile/android` and finds it as project `:watch-link`). With the Android env above, in `mobile/android`:
  - JVM tests (`KeyWrapTest`, no device): `./gradlew :watch-link:testDebugUnitTest`.
  - Instrumented tests (`KeysTest`, real AndroidKeyStore; the AVD `chase-cashew-test` must be running): `./gradlew :watch-link:connectedDebugAndroidTest`. They run in the module's own test APK (its own UID, Keystore and `noBackupFilesDir`), so they never touch the installed app's keys.
  - `StagingStoreTest` and `FramesTest` (software key, no device) run under the same `:watch-link:testDebugUnitTest`; `StagingStoreKeystoreTest` (the real Keystore key) under `connectedDebugAndroidTest`. Set `ANDROID_SERIAL=emulator-5554` when a phone or watch is also attached.
  - Neither runs in `pnpm verify`.
- Kotlin keys: `Keys.databaseKey()` reads `noBackupFilesDir/keys/db.key.v1`; a file without the Keystore alias (or the alias without the file) is `KeyLostException`, which JS sees as `KeyLostError` from `src/platform/watchLinkModule.ts`, the only file meant to import the native module (nothing enforces it). `keyState()` "existing" means the file and the alias are both present, not that they unwrap: branch on the `getDatabaseKeyHex` rejection, and treat "fresh" as safe only when no database file exists.

- Staging: activities the watch hands over wait in `noBackupFilesDir/staging/<activityId>.bin` and queued routes in `noBackupFilesDir/outbox/<routeId>.bin` (AES-GCM under the Keystore key `crossfog.staging.v1`, id as AAD; both are `StagingStore`s). The TS side is `src/link/` over `src/platform/watchLinkModule.ts`; `createFakeWatchLink()` stands in for tests. `stageForTest(offerJson)` is registered only by the `src/debug` source set (the `src/release` twin is empty), so it is absent from a release dex; check with `unzip -p <apk> 'classes*.dex' | grep -a -c stageForTest`. A staged item that no longer authenticates or parses is skipped by `pendingActivities` and stays on disk.

## Tracked bundle

`generated/web.ts` is tracked. A `CROSSFOG_E2E=1` build or `pnpm generate` regenerates it, and the e2e flavour contains the developer-only "Dev: drop fog cache" button. After any e2e build run `git status --short` and restore it with `git checkout -- generated/web.ts`. Stage files by name, never with `git add -A`.

## Build and Maestro gotchas

- Gradle does not track `generated/web.ts` (it sits outside `mobile/`), so `createBundleReleaseJsAndAssets` can report `UP-TO-DATE` and ship the previous bundle. Before an Android build that changes the bundle (normal and e2e, either way, or an adapter change) run `rm -rf mobile/android/app/build/generated/{assets,res,sourcemaps}/react/release`, and check the build log shows the task ran. Hermes keeps some strings as UTF-16, so grep an APK bundle with `grep -a -c -P` on the spaced form.
- `android-mcp`'s device-side helper holds the UiAutomation connection, so Maestro fails with "Android driver did not start up in time". Kill the `com.wetest.uia2.Main` process on the device before a Maestro run; the next `Snapshot` restarts it.
- Maestro reports off-screen web view text as visible, so do not guard a swipe with `notVisible`. Use a fixed swipe, and assert that the app was left with `notVisible: "Expand or collapse panel"`.

## Tools

- Expo docs, EAS build status: the Expo MCP (`read_documentation`, `search_documentation`, `build_list`). Its builds run in the cloud and do not drive a local emulator.
- Android: `android-mcp` for the UI (never `adb shell uiautomator dump`, it crashes the service), and `adb`, the emulator and Gradle for builds, logs and root. There is no Android Studio MCP.
- Build and test output is large. Save it to a file and read `tail`/`jq` slices.

## Commit hook

A hook blocks `git commit` while comment-like lines are unreviewed (markdown, text and lockfiles are exempt). A new Maestro flow with no `#` lines still needed a review (probably because of the YAML `---` separator, which starts with `--`). Finish the edits, run the `pr-review-toolkit:comment-analyzer` agent alone with the first prompt line exactly `Repository: /Users/leo/Lab/defog`, wait for its report, re-run it if you changed a comment, then commit in a following turn. Do not bypass the hook.

## Private data

The owner's real backup (`Sync.zip`) is location history. Load it only on a device or through the page's own file input; never upload, commit or paste it.
