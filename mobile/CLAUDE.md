# Cross the Fog (Expo app)

Read `AGENTS.md` first: Expo APIs change every SDK, so fetch the versioned docs (`expo` is `~57`, `https://docs.expo.dev/versions/v57.0.0/`) before touching an Expo, EAS or React Native API.

## Commands

- Unit tests: `pnpm test` (vitest, projects `unit` and `adapter`). One file: `npx vitest run test/unit/incoming.test.ts --reporter=dot`.
- Typecheck: `pnpm typecheck` (it runs `pnpm generate` first). Lint: `npx biome check <paths>`; existing warnings in `test/adapter/hooks.test.ts` are unrelated.
- Full gate: `pnpm verify`.
- Builds: use `pnpm ios` / `pnpm android`; they regenerate the web bundle first. A raw `npx expo run:*` does not.
- Android builds need JDK 21 (`JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home`), `ANDROID_HOME=$HOME/Library/Android/sdk`, and `--device <AVD name>`, not the adb serial.
- e2e builds need `CROSSFOG_E2E=1` for the web build, the app config and the prebuild, and a Release configuration. Run Maestro against them with `maestro --device <udid|serial> test .maestro`.
- Pull requests: `gh pr create --repo leonardoazeredo/defog --base main`.

## Tracked bundle

`generated/web.ts` is tracked. A `CROSSFOG_E2E=1` build or `pnpm generate` regenerates it, and the e2e flavour contains the developer-only "Dev: drop fog cache" button. After any e2e build run `git status --short` and restore it with `git checkout -- generated/web.ts`. Stage files by name, never with `git add -A`.

## Tools

- Expo docs, EAS build status: the Expo MCP (`read_documentation`, `search_documentation`, `build_list`). Its builds run in the cloud and do not drive a local simulator.
- iOS simulator: `mobilebuildmcp` (build, run, screenshot, record video). It has no tap tool: use Maestro for taps. It does not inherit the shell environment, so pass `CROSSFOG_E2E=1` through its `extraArgs` for an e2e build.
- Android: `android-mcp` for the UI (never `adb shell uiautomator dump`, it crashes the service), and `adb`, the emulator and Gradle for builds, logs and root. There is no Android Studio MCP.
- Build and test output is large. Save it to a file and read `tail`/`jq` slices.

## Commit hook

A hook blocks `git commit` while comment-like lines are unreviewed (markdown, text and lockfiles are exempt). Finish the edits, run the `pr-review-toolkit:comment-analyzer` agent alone with the first prompt line exactly `Repository: /Users/leo/Lab/defog`, wait for its report, re-run it if you changed a comment, then commit in a following turn. Do not bypass the hook.

## Private data

The owner's real backup (`Sync.zip`) is location history. Load it only on a device or through the page's own file input; never upload, commit or paste it.
