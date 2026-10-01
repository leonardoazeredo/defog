# Cross the Fog — mobile

A React Native shell that embeds [defog](https://github.com/szalapak/defog) in a WebView with native import, export, share-to-app and persistence.

## What it is

The app wraps the defog web app in a full-screen WebView. A thin web adapter injected at build time bridges the native side (file system, share sheet, back button) to the page. The `app/` directory from the upstream defog repo is never edited; native behaviour is added entirely through the adapter.

## Requirements

- **Node** ≥ 26
- **pnpm** 11
- **Xcode** 26 (iOS builds)
- **Android SDK** with build-tools and NDK r27+ (Android builds and `check-apk.sh`)
- **Maestro** (e2e flows) — install from <https://maestro.mobile.dev>

## Scripts

| Script | What it does |
|--------|-------------|
| `pnpm generate` | Builds `generated/web.ts` and `generated/licenses.json` |
| `pnpm start` | Generates, then starts the Expo dev server |
| `pnpm android` | Generates, then builds and launches on Android |
| `pnpm ios` | Generates, then builds and launches on iOS |
| `pnpm typecheck` | Generates, then runs `tsc --noEmit` on all tsconfigs |
| `pnpm lint` | Runs Biome |
| `pnpm test` | Runs unit and adapter tests with Vitest |
| `pnpm verify` | Full check: typecheck, lint, tests, contract, build:web, knip |
| `pnpm e2e` | Runs Maestro flows against a running device or simulator |
| `pnpm run licenses` | Regenerates `generated/licenses.json` |
| `scripts/check-apk.sh <apk>` | Checks permissions, targetSdk, zip-align and 16 KB ELF alignment |
| `scripts/privacy-union.ts` | Unions Pod privacy manifests; output goes into `app.config.ts` |

## How the page is built

`scripts/build-web.ts` reads `app/index.html`, bundles the adapter sources in `web-adapter/`, inlines them, and writes a TypeScript module that exports the HTML string as `WEB_HTML`. The WebView loads this string with `baseUrl: "https://crossfog.madera.codes/"`.

The host policy (`scripts/web/hostPolicy.ts`) enforces a static allowlist of external origins. Any new origin added to `app/` must be reviewed and listed there.

## Running the e2e flows

Build the app with the `e2e` flag, then run Maestro:

```bash
# Android
CROSSFOG_E2E=1 pnpm android
pnpm e2e

# iOS (simulator only)
CROSSFOG_E2E=1 pnpm ios
pnpm e2e
```

`CROSSFOG_E2E=1` replaces the system file picker with an in-app Alert that resolves to a bundled fixture.

## Upstream merge procedure

1. Run `git diff HEAD...upstream/main -- app/` before merging, because that code will run next to users' location history.
2. Merge.
3. Run the build (contract and host checks) and the tests.
4. Never resolve a conflict inside `app/`.

## Domain rules (D11)

- Nothing is ever hosted at `crossfog.madera.codes`. The `ORIGIN` constant is a stable namespace used only by the WebView's security policy and the contract check's request interception.
- `madera.codes` never gets a wildcard DNS record.
- The app's website lives at `madera.codes/crossfog`.
