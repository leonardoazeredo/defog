// bench/lib/fetch-cache.js keys the disk cache on the request with rectQuery's [timeout:25]
// keyed as [timeout:60], the timeout its saved answers are keyed on, while bench/overpass.js's
// [timeout:120] keeps its own key. No network.
//   node bench/fetch-cache.test.js
"use strict";
const assert = require("node:assert/strict");
const { keyFor } = require("./lib/fetch-cache.js");

const url = "https://overpass-api.de/api/interpreter";
// as StreetIndex.overpassFetch builds it: the query URL-encoded behind data=
const body = (q) => "data=" + encodeURIComponent(q);
const query = (timeout, box = "51.0,13.7,51.1,13.8") => `[out:json][timeout:${timeout}];(way[highway~"^(residential)$"](${box});)->.all;.all out skel geom;`;

assert.equal(keyFor(url, body(query(25))), keyFor(url, body(query(60))), "rectQuery's 25 reads as the saved 60");
assert.notEqual(keyFor(url, body(query(120))), keyFor(url, body(query(60))), "a 120 request does not share the saved 60 key");
assert.equal(keyFor(url, query(25)), keyFor(url, query(60)), "a raw, unencoded body normalises the same way");
assert.notEqual(keyFor(url, body(query(25))), keyFor(url, body(query(25, "51.0,13.7,51.1,13.9"))), "the box does");
assert.notEqual(keyFor(url, body(query(25))), keyFor("https://overpass.private.coffee/api/interpreter", body(query(25))), "so does the host");
assert.equal(keyFor(url, undefined), keyFor(url, ""), "no body reads as an empty one");
// the saved files were keyed on the literal [timeout:60] request, so a normalised request must hash to the same name
const crypto = require("crypto");
assert.equal(keyFor(url, body(query(25))), crypto.createHash("sha1").update(url + "\n" + body(query(60))).digest("hex"), "the key of a saved [timeout:60] answer");
const literal = (b) => crypto.createHash("sha1").update(url + "\n" + b).digest("hex");
assert.equal(keyFor(url, body(query(120))), literal(body(query(120))), "bench/overpass.js's [timeout:120] answers keep their literal key");
console.log("fetch-cache.test.js ok");
