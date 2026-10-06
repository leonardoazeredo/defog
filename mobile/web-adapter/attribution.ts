const STYLE_ID = "crossfogAttribution";

// Leaflet's control layer sits above the bottom sheet and the map runs full-bleed under it, so the attribution lands on the
// sheet's lowest rows and swallows taps there. The offsets mirror the sheet's own --peek and open height in app/index.html;
// test/adapter/attribution.test.ts fails if upstream changes them.
const CSS = `@media (max-width: 720px) {
  .leaflet-bottom.leaflet-right { bottom: 100px; transition: bottom .28s cubic-bezier(.4, 0, .2, 1); }
  body:has(#sidebar.open) .leaflet-bottom.leaflet-right { bottom: 68vh; bottom: 68svh; }
}`;

export function installAttributionLift(doc: Document): void {
  if (doc.getElementById(STYLE_ID) != null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
