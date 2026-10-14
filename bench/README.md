# Benchmark harness

Measures suggestion quality against real Fog of World data, headless under Node.
Needs a `Sync/` folder in the repo root (gitignored: it is personal location
history, never commit it).

```
node bench/characterize.js          # defog density maps; pick scenario centres
node bench/run.js [out] [filter]    # run the app's SuggestTool on bench/scenarios.js
node bench/overpass.js [filter]     # street-network context (total vs undefogged km)
```

- `lib/load.js` loads the real `app/src` parser + suggest code over a Leaflet stub,
  so benchmarks exercise the exact shipping algorithm.
- `lib/gain.js` replicates `computeGain`/`cellIsNew` from `main.js` (kept in sync by hand).
- All BRouter/Overpass responses are disk-cached in `bench/cache/` (gitignored):
  re-runs are free, reproducible, and kind to the public servers. Delete the cache
  to re-measure live. Avoid live runs while also testing in the browser: brouter.de
  throttles per IP.
- Results land in `bench/out/<name>.json` (gitignored) with per-card metrics:
  defogged area, m² per metre, % new ground, overlap %, elongation
  (1 = round blob, 3+ = a proper thin "line" of a loop).

## A to B wanted distance

`node bench/p2p-window.test.js` checks the window maths with no network or fog.
`node bench/p2p-target.js [profile]` runs the six routing profiles through the real
`SuggestTool` against your fog (`P2P_PINS="lat,lng;lat,lng"` picks the pins, default
is the Dresden `neustadt-p2p` pair). One live run per profile is enough: responses are
cached. brouter.de answers 403 "Please, retry later" when throttled; a rerun after a
few minutes refetches only what failed.

Observed on a real fog, ~4 km pins, 15% buffer unless noted:
- trekking, fastbike, hiking-mountain, car-fast, rail, shortest: all cases stay inside
  the promised window.
- A 5% window at 1.5x the fastest route often finds nothing (trekking, car-fast, rail,
  shortest) and shows the fastest route as a flagged fallback.
- 10x the fastest route is reachable on trekking and fastbike, but falls back on
  hiking-mountain, car-fast, rail and shortest.
- Retracing (`node bench/p2p-target.js` prints `retr max`, the best card's m2/km and the
  fetch count per case, BRouter and Overpass, cache hits included). Before/after the
  retrace work, same pins, 15% buffer, cache warm; only trekking and fastbike completed
  (the other four were throttled), and reruns differ by a few percent:
  - trekking, 1.5x: max retrace 15% -> 9%, best area per km 21268 -> 21533; 5% window
    unchanged (25%, 22288); 10x: 77% both, area per km 23737 -> 25664.
  - fastbike, 1.5x: max retrace 31% -> 10%, best area per km 19863 -> 20563; 5% window
    19918 -> 22117 (max retrace 11% -> 23%, a better card, not a worse route).
  - fetches per run: +0 to +2 (the re-route cap is 2).
  A card that retraces on purpose (a real dead end) is only discounted, never dropped.
- car-fast and rail search the "bike" street set (`streetKind`), so their candidates
  are not guided by car or rail networks.
