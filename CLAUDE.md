# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Defog: a browser-only tool that reads a Fog of World `Sync/` folder (or backup .zip) and overlays visited ground on a Leaflet map, then plans/suggests routes that defog the most new area. The fog data never leaves the browser; only waypoints/bounding boxes go to BRouter and Overpass (see README "Privacy" before adding any network call).

## Running and deploying

- No build, package manager, linter or test suite. `app/` is the site root: serve it with any static file server and open `index.html`.
- Pushing to `main` deploys `app/` to GitHub Pages via `.github/workflows/deploy.yml`. Anything outside `app/` is not published.
- `Sync/` (personal location history) is gitignored: never commit it or anything derived from it.
- Third-party libs are vendored in `app/vendor/`; there is nothing to install.

## Architecture

Every file in `app/src/` is a plain IIFE that hangs its API on `window` (e.g. `FogParser`, `StreetIndex`, `SuggestTool`). There are no imports: **load order in `app/index.html` is the dependency graph**, so a new file must be added there after what it uses and before `main.js`.

Data flow:
- `unzip.js` / `parser.js`: Sync tiles (zlib) -> `FogMap` of visited cells. Fog grid is 2^22 cells wide, 1 cell = 1 px at map zoom 14; `parser.js` also owns the cell <-> lng/lat math everything else uses.
- `fogLayer.js`: Leaflet GridLayer painting the fog (paints one side, composites with a CSS blend mode on the pane).
- `streets.js`: `StreetIndex` fetches OSM ways from Overpass in tiles and scores ~50 m segments by the share of their ~30 m corridor still fogged. Shared by `streetsLayer.js` ("Streets in fog" highlight), `planner.js` and `suggest.js`.
- `route.js`: manual route tool (the only BRouter caller: snapping, drag/insert waypoints, GPX; `setFixedRoute` takes a suggestion's geometry without a request). `export.js`: fog -> KML.
- `planner.js`: graph search over StreetIndex ways (pockets of rewarding streets joined by reward-hungry paths, rewards spent as edges are used so loops come back on different streets). Runs locally and returns real street geometry (`coords`). Builds the street graph (components, one-way directions, travel-class filter) that `router.js` routes on.
- `router.js`: `LocalRouter`, shortest paths over the planner graph (via points, per-edge avoid penalties, `explain` for why a route failed). Load order: after `planner.js`, before `suggest.js`.
- `suggest.js`: `SuggestTool` (A->B and loop modes). Never calls BRouter: fetches streets from Overpass, then routes via-point and planner candidates locally and scores each with the `computeGain` callback it is given. A failed run emits `{error, reason, why}`.
- `main.js`: wires the UI, style controls, persistence, and defines `computeGain`/`cellIsNew` as closures over UI state.

## Benchmark harness (`bench/`)

Headless Node run of the shipping suggestion code against a real `Sync/` folder in the repo root:

    node bench/characterize.js          # density maps, pick scenario centres
    node bench/run.js [out] [filter]    # run SuggestTool on bench/scenarios.js
    node bench/overpass.js [filter]     # street-network context
    node bench/compare.js <baseline.json> <candidate.json>   # acceptance check, see bench/README.md
    for t in bench/*.test.js; do node $t; done               # synthetic-graph tests, no network

- `bench/lib/load.js` `require`s `parser.js`, `streets.js`, `planner.js`, `router.js`, `suggest.js` over `bench/lib/leaflet-stub.js`; a new app file that suggest code depends on must be added there too.
- `bench/lib/gain.js` is a hand copy of `computeGain`/`cellIsNew` from `main.js`. Change one, change the other.
- Overpass responses are cached in `bench/cache/` (gitignored); delete it to re-measure live. Overpass answers 502 under load and the run then ends in the error state: rerun after a minute, only failed requests refetch. `bench/cache/brouter/` is the old baseline only; nothing fetches BRouter now.
- Results go to `bench/out/<name>.json` (gitignored).
