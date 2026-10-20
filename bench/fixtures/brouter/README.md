# BRouter fixtures

Responses of the public BRouter server (`brouter-1.7.11-beta`), saved so `bench/estimates.test.js` can
check `app/src/estimates.js` against BRouter's own distance, filtered ascent and time. Fetched once
with `curl` on 2026-10-20 from three public places chosen for their relief; none is near the owner's
own areas, and nothing here comes from `bench/cache/` or `Sync/`.

| File prefix | Place | `lonlats` | Relief |
|---|---|---|---|
| `tiergarten-` | Tiergarten, Berlin | `13.350,52.514\|13.377,52.516` | flat |
| `hyde-park-` | Hyde Park to Primrose Hill, London | `-0.175,51.507\|-0.160,51.539` | rolling |
| `arthurs-seat-` | Arthur's Seat, Edinburgh | `-3.166,55.944\|-3.175,55.953` | hilly |

Each place has one file per profile (`trekking`, `fastbike`, `hiking-mountain`, `shortest`), from

    https://brouter.de/brouter?lonlats=<lon,lat|lon,lat>&profile=<profile>&alternativeidx=0&format=geojson

All twelve responses carry a third (elevation) coordinate, so none was skipped.

The test reads `properties["track-length"]`, `"filtered ascend"` and `"total-time"` and the
`[lon, lat, ele]` coordinates. In these files the 10 m ascent filter matches eleven of twelve; the
twelfth (`hyde-park-fastbike`) matches only with 5 m, which BRouter applies where its elevation data
is 1 arc second.

## Licence and data

BRouter is MIT licensed (`mobile/licenses/brouter-LICENSE.txt`). Routes are derived from OpenStreetMap
data, (c) OpenStreetMap contributors, ODbL (`https://www.openstreetmap.org/copyright`); elevations
come from the elevation data BRouter serves (SRTM and others).
