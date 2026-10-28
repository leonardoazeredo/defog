// pako_deflate.min.js and pako_inflate.min.js both assign window.pako, so the one loaded second hides the first.
// The deflate build loads first and is parked here; the inflate build then takes `pako` as unzip.js and main.js expect.
(function (global) {
  // a wrong script order fails here, at load, rather than at the first Fog of World export
  if (!global.pako || typeof global.pako.deflate !== "function") {
    throw new Error("pakoDeflate.js must load right after vendor/pako_deflate.min.js, before pako_inflate.min.js");
  }
  global.pakoDeflate = global.pako;
})(window);
