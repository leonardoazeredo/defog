// StreetMessages: what the page says about a street download, from the error's reason, counts and retry
// time only, never its message.
//   node bench/street-messages.test.js
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
global.window = global;
require("../app/src/streetMessages.js");
const { StreetMessages } = global;
const { describe, progress } = StreetMessages;

const now = 1_000_000;
const err = (reason, more) => Object.assign(new Error("overpass HTTP 502"), { reason }, more);

{ // busy: the retry time rounded up to 10 s, or a minute without one
  assert.equal(describe(err("busy", { retryAt: now + 23_000 }), now), "The street servers are busy. Try again in about 30 s.");
  assert.equal(describe(err("busy", { retryAt: now + 30_000 }), now), "The street servers are busy. Try again in about 30 s.");
  assert.equal(describe(err("busy"), now), "The street servers are busy. Try again in a minute.");
}
{ // a retry time already passed still says the shortest wait; one over two minutes is told in minutes
  assert.equal(describe(err("busy", { retryAt: now - 5000 }), now), "The street servers are busy. Try again in about 10 s.");
  assert.equal(describe(err("busy", { retryAt: now + 120_000 }), now), "The street servers are busy. Try again in about 120 s.");
  assert.equal(describe(err("busy", { retryAt: now + 121_000 }), now), "The street servers are busy. Try again in about 3 min.");
  assert.equal(describe(err("busy", { retryAt: now + 600_000 }), now), "The street servers are busy. Try again in about 10 min.");
}
{ // blocked: for today, whatever the retry time
  const text = "The street server has blocked this network for today: it caps each network's daily use. Try another network, or try again tomorrow.";
  assert.equal(describe(err("blocked"), now), text);
  assert.equal(describe(err("blocked", { retryAt: now + 3_600_000 }), now), text);
}
{ // stalled: a silent server or a run out of time, with the retry time or a few minutes
  assert.equal(describe(err("stalled", { retryAt: now + 30_000 }), now), "The street server is slow to answer. Try again in about 30 s.");
  assert.equal(describe(err("stalled"), now), "The street server is slow to answer. Try again in a few minutes.");
}
{ // offline
  assert.equal(describe(err("offline"), now), "You're offline. This area's street map is downloaded once and kept on the phone.");
}
{ // partial: the counts, and what stopped the run when the cause says
  const partial = (cause, more) => Object.assign(new Error("streets: got 7 of 12 tiles"), { reason: "streets-partial", done: 7, total: 12, cause }, more);
  assert.equal(describe(partial(err("server")), now),
    "Got 7 of 12 pieces of the street map before the server stopped. Try again: only the rest is downloaded.");
  assert.equal(describe(partial(err("stalled")), now),
    "Got 7 of 12 pieces of the street map before the server got too slow. Try again: only the rest is downloaded.");
  assert.equal(describe(partial(err("offline")), now),
    "Got 7 of 12 pieces of the street map before the connection dropped. Try again: only the rest is downloaded.");
  assert.equal(describe(partial(err("busy", { retryAt: now + 41_000 }), { retryAt: now + 41_000 }), now),
    "Got 7 of 12 pieces of the street map before the server stopped. Try again in about 50 s: only the rest is downloaded.");
  assert.equal(describe(partial(err("blocked"), { retryAt: now + 3_600_000 }), now),
    "Got 7 of 12 pieces of the street map before the server blocked this network for today. Try another network, or try again tomorrow: only the rest is downloaded.");
  assert.equal(describe(partial(undefined), now),
    "Got 7 of 12 pieces of the street map before the server stopped. Try again: only the rest is downloaded.");
}
{ // server, an unknown reason, none at all, a bug, or no error: the generic text
  const text = "Couldn't download the street map. Try again in a minute.";
  for (const e of [err("server"), err("teapot"), err(undefined), new TypeError("x is undefined"), null, undefined]) {
    assert.equal(describe(e, now), text);
  }
  assert.equal(describe({ reason: "streets-partial" }, now), text, "a partial error without counts says nothing made up");
}
{ // a server remark, a tile number or the message never comes through
  const remark = "runtime error: Query timed out in \"query\" at line 3 after 61 seconds.";
  for (const reason of ["busy", "blocked", "stalled", "offline", "server", "streets-partial", "teapot"]) {
    const e = Object.assign(new Error("overpass: " + remark), { reason, done: 3, total: 12, cause: new Error(remark), why: remark });
    const text = describe(e, now);
    assert.ok(!/timed out|query|line 3|61/.test(text), reason + ": " + text);
  }
}
{ // progress, and without counts yet
  assert.equal(progress(3, 12), "Downloading the street map, 3 of 12…");
  assert.equal(progress(0, 12), "Downloading the street map, 0 of 12…");
  assert.equal(progress(undefined, undefined), "Downloading the street map…");
}
{ // main.js words a failed street download through StreetMessages, never from the error's text
  const main = fs.readFileSync(path.join(__dirname, "..", "app", "src", "main.js"), "utf8").split("\n");
  for (const [i, line] of main.entries()) {
    assert.ok(!/\.message\b|String\(w\)/.test(line), "main.js:" + (i + 1) + " shows an error's text: " + line.trim());
  }
  const fetchLines = main.filter((l) => l.includes('"streets-fetch"'));
  assert.equal(fetchLines.length, 2, "the suggestion card and the route hint each word streets-fetch");
  for (const l of fetchLines) assert.match(l, /StreetMessages\.describe\(/, l.trim());
  assert.ok(main.some((l) => /StreetMessages\.progress\(s\.done, s\.total\)/.test(l) && l.includes('"streets"')), "the suggestion shows the download's progress");
}
{ // the page loads it before the layer and main.js that call it
  const html = fs.readFileSync(path.join(__dirname, "..", "app", "index.html"), "utf8");
  const at = (f) => html.indexOf('src="src/' + f + '"');
  assert.ok(at("streetMessages.js") > 0, "loaded");
  assert.ok(at("streetMessages.js") < at("streetsLayer.js") && at("streetMessages.js") < at("main.js"), "before streetsLayer.js and main.js");
}

console.log("street-messages.test.js ok");
