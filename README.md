# Defog

A small, browser-based tool that reads your **[Fog of World](https://fogofworld.app/)**
sync data and renders where you've been as an overlay on a real map to help you plan routes that maximise new defogging.

Your Fog of World data is read and rendered entirely in your browser, it is never
uploaded anywhere.

**→ Open the app: <https://szalapak.github.io/defog/>**

## Features

- Parses the Fog of World `Sync/` format (zlib-compressed tiles → visited cells).
- Renders the fog as a canvas overlay on a real basemap (OSM / CyclOSM / a dark
  variant of OSM), decoding only the tiles in view so large datasets stay responsive.
- **Fog look:** shade the ground you've visited (colour, opacity, and **Widen** to fatten
  thin tracks), or switch to **Streets in fog**, which keeps that shading and highlights the
  streets and paths still covered by fog, heatmap-style. Only the stretches still in fog
  light up, so a half-done street shows just its missing half, and the ones your Plan mode
  can't take are faded rather than hidden. Pick the highlight colour and strength; works
  zoomed in to about a town at a time, and unlocks a dark basemap where the streets glow.
- **Live "% defogged"** of the current view in the header.
- **Route planning** snapped to real streets by a router that runs in your browser (bike / road /
  walk / car): draggable & line-insertable waypoints, a **Reverse** button that
  re-routes the trip the other way round, distance, time + elevation profile,
  and an estimate of the **new area a route would defog**. Export the route as GPX / KML,
  or open it in Google Maps. km/mi units.
- **Suggested routes ("surprise me"):** Pick **A → B** and get up
  to three options, routed on the street map in your browser, that maximise defogging within a length budget (fastest
  route + 5/15/30%, your pick), or pick a **start + distance** and get loops that head
  into your foggiest directions. Every option is scored against your actual fog: the cards
  show distance, defogged area and % new ground (no climb on the cards). Tap **Use** to load
  one into the editor for tweaking and export, where its climb and elevation profile appear
  once the heights arrive; editing a pin then re-routes on the street map.

## Privacy

Your Fog of World data is parsed and drawn in your browser and is never sent
to any server. Some features do make outbound requests, and only with the coordinates needed
for that feature (not your fog data). No routing service is involved: **drawing a route by hand**
(and editing a pin of a suggested route, switching its mode or reversing it) and **route
suggestions** are routed entirely on your device and send nothing but the bounding box of the
**street map around your pins** (a kilometre beyond them; a hand-drawn route also asks for its
heights, see **Route elevation** below). The **Streets in fog** look is drawn from the streets
already on your device and fetches the street map of the **area on screen** only when you tap its
**Download this area** button. Both get the street map from a public Overpass API server
(OpenStreetMap): the main instance [overpass-api.de](https://overpass-api.de)
first, then [private.coffee](https://overpass.private.coffee/) (its terms and privacy policy are on
that page) if the main one fails, has not started answering within 15 seconds or has not finished
within 30 seconds; the order is a setting. The street map comes in tiles of 0.025° (about 3 km
tall, 2 km wide at mid latitudes), one request each, nearest first, each saved in the street
cache (below) as it arrives. As the main instance's usage policy asks, the phone
app's web view identifies the app to the server by its User-Agent and Referer. That server also
caps each app's and each network address's daily use, and answers 406 once the share is used up:
the app then leaves that server alone for an hour, longer if the server says so. They only see
bounding boxes, the same class of information the basemap tile servers already get, and the
streets are compared against your fog entirely on your device; and **"Maps ↗"** opens
your waypoints in Google Maps. The street map it fetches is kept as a street cache in your
browser's storage (IndexedDB, as plain data, never uploaded and left out of backups), so planning in
an area you have planned in before needs no connection. After 90 days a copy is out of date:
**Streets in fog** still draws it, and a suggestion in that area fetches it fresh,
using the old copy only while there is no connection. **Route elevation** (ascent, descent, the profile) comes
from the [AWS Open Data terrain tiles](https://registry.opendata.aws/terrain-tiles/), public elevation
data such as SRTM, fetched from the bucket's own host (`elevation-tiles-prod.s3.amazonaws.com`) one
zoom-12 map tile at a time (about 50 KB each); the server sees only the tile numbers and your
connection's address, the same class of information the basemap tile servers get, and the heights are
read on your device. Those tiles are kept in your browser's storage too (IndexedDB, plain data, never
uploaded, left out of backups). As with any web map, basemap tiles are fetched from their providers
(OpenStreetMap / CyclOSM), which reveals the map area you're viewing to them.
In the phone app, **Back up…** writes one file to a place you choose and makes no network call. The backup
holds your activities (every track with its times), your routes, the Fog of World import you last loaded and
the page's saved settings, and nothing from the caches (street map, elevation tiles, derived fog). It is
encrypted with a passphrase you type into the app, never into the page (SQLCipher), unless you tick
"No encryption" after a warning: an unencrypted backup shows where you were and when. If you lose the
passphrase nobody can open that backup, and if you lose the phone without a backup your history is gone.
**Restore…** replaces everything on the phone with a backup, after you confirm.
Exports are plain files and happen only when you tap them, each after a warning you can cancel (Cancel
sends nothing). **Export for Fog of World** (phone app) writes the cells you have explored, imported and
from activities, in Fog of World's own format, which has no encryption and no times; the phone app zips
the tiles under `Sync/` and asks where to save the zip. **GPX** and **KML** write the route you planned,
point by point, and **"Maps ↗"** hands its start, end and stops to Google Maps. The crash log and the
page's log lines carry no positions: a decimal number with three or more places is replaced by `[n]`
before the crash log is written.
The site also counts visits with [GoatCounter](https://www.goatcounter.com/), a
privacy-friendly, cookie-less counter (page views only; no personal data, no tracking
across sites).

## Use it

Open **<https://szalapak.github.io/defog/>** in your browser and click
**"Pick your Sync folder…"** to load any Fog of World `Sync` folder. 

## Project layout

```
app/
  index.html        UI (map + sidebar: fog look / plan tabs)
  src/parser.js     Fog of World format → visited cells (+ tile↔lat/lng math)
  src/fogLayer.js   Leaflet GridLayer that paints the fog, with the look/blend/widen options
  src/route.js      draw-your-own route tool (GPX/KML export)
  src/routeLocal.js routes the tool's pins on the street map, with heights and estimates
  src/suggest.js    suggested routes: candidate generation, defog scoring, loop shaping
  src/unzip.js      minimal ZIP reader so a Fog of World backup .zip loads directly
  src/main.js       wiring: data loading, style controls, route/suggest UI, persistence
  vendor/           Leaflet + pako (zlib), vendored so there's nothing to install
Sync/               
```

## Data format (credits)

The sync format was reverse-engineered by
[CaviarChen/Fog-of-World-Data-Parser](https://github.com/CaviarChen/Fog-of-World-Data-Parser)
(see also [Fog Machine](https://github.com/CaviarChen/fog-machine)). `parser.js` is a
faithful browser port of that work. World = 512×512 Web-Mercator tiles; each tile file is
zlib-compressed and holds a 128×128 block header indexing 64×64-bit bitmaps. One set bit =
one defogged cell; the grid is 2²² cells wide, which lines up 1:1 with map pixels at zoom 14.

## License

App code: MIT. Vendored libraries keep their own licenses (Leaflet: BSD-2, pako: MIT).
