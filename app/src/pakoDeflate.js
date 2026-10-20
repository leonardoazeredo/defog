// pako_deflate.min.js and pako_inflate.min.js both assign window.pako, so the one loaded second hides the first.
// The deflate build loads first and is parked here; the inflate build then takes `pako` as unzip.js and main.js expect.
(function (global) {
  global.pakoDeflate = global.pako;
})(window);
