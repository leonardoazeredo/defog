import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ORIGIN } from "../../src/bridge/protocol.js";
import { installLinks } from "../../web-adapter/links.js";

it("opens the attribution's copyright link in the system browser", () => {
  const sent = install();
  document.body.innerHTML =
    '<div class="leaflet-control-attribution">&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></div>';
  const a = document.querySelector("a");
  if (a == null) throw new Error("no link rendered");
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
  expect(sent).toEqual([
    { v: 1, type: "openExternal", url: "https://www.openstreetmap.org/copyright" },
  ]);
});

it("app/src/main.js links every basemap attribution to the OSM copyright page", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../../../app/src/main.js"), "utf8");
  const attributions = [...src.matchAll(/attribution: '([^']+)'/g)].map((m) => m[1]);
  expect(attributions).toHaveLength(3);
  for (const a of attributions)
    expect(a).toContain(
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">',
    );
});

// jsdom's default base is localhost, but in the WebView the page's base is ORIGIN, which a relative href resolves against.
function pageAt(origin: string, body: string): void {
  document.head.innerHTML = `<base href="${origin}">`;
  document.body.innerHTML = body;
}

// installLinks has no way to uninstall, so a listener left on the shared document would also answer later tests' clicks and
// let a missing preventDefault go unnoticed.
const added: [string, EventListenerOrEventListenerObject][] = [];
const addEventListener = document.addEventListener.bind(document);
document.addEventListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  opts?: unknown,
) => {
  added.push([type, listener]);
  addEventListener(type, listener, opts as boolean);
};

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  for (const [type, listener] of added.splice(0))
    document.removeEventListener(type, listener, true);
});

function install(): unknown[] {
  const sent: unknown[] = [];
  installLinks(window, document, (m) => sent.push(m));
  return sent;
}

function click(el: Element, type = "click", button = type === "auxclick" ? 1 : 0): MouseEvent {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button });
  el.dispatchEvent(ev);
  return ev;
}

it("opens a foreign link with no target (Leaflet's own attribution link) in the system browser", () => {
  const sent = install();
  pageAt(
    ORIGIN,
    '<div class="leaflet-control-attribution"><a href="https://leafletjs.com" title="A JavaScript library for interactive maps">Leaflet</a></div>',
  );
  const a = document.querySelector("a");
  if (a == null) throw new Error("no link rendered");
  const ev = click(a);
  expect(ev.defaultPrevented).toBe(true);
  expect(sent).toEqual([{ v: 1, type: "openExternal", url: "https://leafletjs.com/" }]);
});

it("opens a foreign link whose target is _self or a named frame outside the app", () => {
  const sent = install();
  pageAt(
    ORIGIN,
    '<a id="s" href="https://example.org/s" target="_self">s</a><a id="n" href="https://example.org/n" target="elsewhere">n</a>',
  );
  for (const id of ["s", "n"]) {
    const a = document.getElementById(id);
    if (a == null) throw new Error("no link rendered");
    expect(click(a).defaultPrevented).toBe(true);
  }
  expect(sent).toEqual([
    { v: 1, type: "openExternal", url: "https://example.org/s" },
    { v: 1, type: "openExternal", url: "https://example.org/n" },
  ]);
});

it("intercepts a click on an element inside the link", () => {
  const sent = install();
  pageAt(ORIGIN, '<a href="https://example.org/inner"><span><b id="deep">x</b></span></a>');
  const deep = document.getElementById("deep");
  if (deep == null) throw new Error("no element rendered");
  expect(click(deep).defaultPrevented).toBe(true);
  expect(sent).toEqual([{ v: 1, type: "openExternal", url: "https://example.org/inner" }]);
});

it("intercepts before a bubbling handler that stops propagation, as Leaflet's controls do", () => {
  const sent = install();
  pageAt(ORIGIN, '<div id="ctl"><a href="https://example.org/ctl">x</a></div>');
  document.getElementById("ctl")?.addEventListener("click", (e) => e.stopPropagation());
  const a = document.querySelector("a");
  if (a == null) throw new Error("no link rendered");
  expect(click(a).defaultPrevented).toBe(true);
  expect(sent).toHaveLength(1);
});

it("intercepts a middle-click (auxclick) on a foreign link", () => {
  const sent = install();
  pageAt(ORIGIN, '<a href="https://example.org/mid">x</a>');
  const a = document.querySelector("a");
  if (a == null) throw new Error("no link rendered");
  expect(click(a, "auxclick").defaultPrevented).toBe(true);
  expect(sent).toEqual([{ v: 1, type: "openExternal", url: "https://example.org/mid" }]);
});

it("leaves a right-click (auxclick, button 2) on a foreign link alone", () => {
  const sent = install();
  pageAt(ORIGIN, '<a href="https://example.org/ctx">x</a>');
  const a = document.querySelector("a");
  if (a == null) throw new Error("no link rendered");
  expect(click(a, "auxclick", 2).defaultPrevented).toBe(false);
  expect(sent).toEqual([]);
});

it("opens a foreign link the same way from window.open as from a click", () => {
  const sent = install();
  pageAt(ORIGIN, "");
  window.open("HTTPS://Example.org/a");
  window.open("//example.org/b");
  window.open("/relative");
  window.open("mailto:a@example.org");
  window.open();
  expect(sent).toEqual([
    { v: 1, type: "openExternal", url: "https://example.org/a" },
    { v: 1, type: "openExternal", url: "https://example.org/b" },
  ]);
});

it("stops a same-origin link with target=_blank and opens nothing", () => {
  const sent = install();
  pageAt(ORIGIN, '<a href="/other" target="_blank">x</a>');
  const a = document.querySelector("a");
  if (a == null) throw new Error("no link rendered");
  expect(click(a).defaultPrevented).toBe(true);
  expect(sent).toEqual([]);
});

it("leaves a fragment-only change of the current document and a blob download alone", () => {
  const sent = install();
  pageAt(
    ORIGIN,
    `<a id="h" href="#">top</a><a id="f" href="#close">close</a><a id="abs" href="${ORIGIN}#z">abs</a><a id="b" href="blob:${ORIGIN}0b1c">blob</a>`,
  );
  for (const id of ["h", "f", "abs", "b"]) {
    const a = document.getElementById(id);
    if (a == null) throw new Error("no link rendered");
    expect(click(a).defaultPrevented, id).toBe(false);
  }
  expect(sent).toEqual([]);
});

// The WebView lets a navigation through when onShouldStartLoadWithRequest answers late (#138), so a same-origin click that
// would load anything has to be stopped here, not by decideNavigation's "block".
it("stops a same-origin link that changes the path or the query without opening anything", () => {
  const sent = install();
  pageAt(
    ORIGIN,
    `<a id="p" href="/other">p</a><a id="q" href="?x">q</a><a id="abs" href="${ORIGIN}x?y=1#z">abs</a><a id="pf" href="/other#frag">pf</a><a id="qf" href="?x#frag">qf</a>`,
  );
  for (const id of ["p", "q", "abs", "pf", "qf"]) {
    const a = document.getElementById(id);
    if (a == null) throw new Error("no link rendered");
    expect(click(a).defaultPrevented, id).toBe(true);
    expect(click(a, "auxclick").defaultPrevented, id).toBe(true);
  }
  expect(sent).toEqual([]);
});

it("stops a link to the page itself with no fragment, which would reload it", () => {
  const sent = install();
  pageAt(
    ORIGIN,
    `<a id="e" href="">e</a><a id="q" href="?">q</a><a id="abs" href="${ORIGIN}">abs</a>`,
  );
  for (const id of ["e", "q", "abs"]) {
    const a = document.getElementById(id);
    if (a == null) throw new Error("no link rendered");
    expect(click(a).defaultPrevented, id).toBe(true);
  }
  expect(sent).toEqual([]);
});

it("counts a fragment link as the current document only when path and query match the page's", () => {
  const sent = install();
  document.head.innerHTML = `<base href="${ORIGIN}app/page?a=1">`;
  document.body.innerHTML =
    '<a id="same" href="#top">same</a><a id="other" href="/app/page#top">other</a><a id="q" href="/app/page?a=1#top">q</a>';
  expect(click(document.getElementById("same") as Element).defaultPrevented).toBe(false);
  expect(click(document.getElementById("other") as Element).defaultPrevented).toBe(true);
  expect(click(document.getElementById("q") as Element).defaultPrevented).toBe(false);
  expect(sent).toEqual([]);
});

it("treats a lookalike host as foreign", () => {
  const sent = install();
  pageAt(
    ORIGIN,
    `<a href="${ORIGIN.replace("https://", "https://x.")}">x</a><a id="u" href="https://crossfog.madera.codes.evil.example/">y</a>`,
  );
  for (const a of document.querySelectorAll("a")) expect(click(a).defaultPrevented).toBe(true);
  expect(sent).toHaveLength(2);
});

it("stops a non-web scheme from navigating without opening anything", () => {
  const sent = install();
  pageAt(
    ORIGIN,
    '<a id="m" href="mailto:a@example.org">m</a><a id="i" href="intent://x#Intent;end">i</a>',
  );
  for (const id of ["m", "i"]) {
    const a = document.getElementById(id);
    if (a == null) throw new Error("no link rendered");
    expect(click(a).defaultPrevented).toBe(true);
  }
  expect(sent).toEqual([]);
});

it("stops a link whose href cannot be parsed from navigating", () => {
  const sent = install();
  pageAt(ORIGIN, '<a href="http://[">x</a>');
  const a = document.querySelector("a");
  if (a == null) throw new Error("no link rendered");
  expect(click(a).defaultPrevented).toBe(true);
  expect(sent).toEqual([]);
});

it("opens a plain http link on the page's own host as foreign", () => {
  const sent = install();
  pageAt(ORIGIN, `<a href="${ORIGIN.replace("https:", "http:")}x">x</a>`);
  const a = document.querySelector("a");
  if (a == null) throw new Error("no link rendered");
  expect(click(a).defaultPrevented).toBe(true);
  expect(sent).toEqual([
    { v: 1, type: "openExternal", url: `${ORIGIN.replace("https:", "http:")}x` },
  ]);
});

it("ignores a click dispatched on the document itself", () => {
  const sent = install();
  pageAt(ORIGIN, "");
  expect(click(document as unknown as Element).defaultPrevented).toBe(false);
  expect(sent).toEqual([]);
});

it("ignores clicks that are not on a link", () => {
  const sent = install();
  pageAt(ORIGIN, '<button id="b">x</button><a name="anchor">no href</a>');
  for (const el of document.querySelectorAll("button, a"))
    expect(click(el).defaultPrevented).toBe(false);
  expect(sent).toEqual([]);
});

// Only a link click is intercepted here. A form submit, a location assignment or a meta refresh would reach the WebView as a
// navigation that navigationPolicy alone can stop, and its answer can arrive late (#138). So nothing the page loads may
// make one; fail here when that changes. index.html, src/ and vendor/ are scanned: a vendored library could navigate on
// its own. The patterns are plain text matches, so an unrelated `.submit(` or `location =` in vendored code is also a hit.
const NAVIGATION_PATTERNS: [string, RegExp][] = [
  ["a <form>", /<form[\s>]/i],
  [
    "a location assignment",
    /\blocation(\.(href|assign|replace))?\s*[-+*/|&]?=[^=]|\blocation\.(assign|replace)\(/,
  ],
  ["a meta refresh", /<meta[^>]*http-equiv\s*=\s*["']?refresh/i],
  ["a formaction", /\bformaction\b/i],
  [".submit()", /\.submit\s*\(/],
];

// file (relative to app/) -> pattern label -> why that hit cannot leave the origin.
const ALLOWED: Record<string, Record<string, string>> = {};

function appFiles(dir: string, prefix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? appFiles(resolve(dir, e.name), `${prefix}${e.name}/`)
      : /\.(js|html)$/.test(e.name)
        ? [`${prefix}${e.name}`]
        : [],
  );
}

it("index.html, src/ and vendor/ cannot navigate except by a link click", () => {
  const root = resolve(import.meta.dirname, "../../../app");
  const files = appFiles(root, "").filter((f) => f === "index.html" || /^(src|vendor)\//.test(f));
  expect(files).toContain("index.html");
  expect(files.some((f) => f.startsWith("vendor/"))).toBe(true);
  for (const f of files) {
    const src = readFileSync(resolve(root, f), "utf8");
    for (const [label, re] of NAVIGATION_PATTERNS) {
      if (ALLOWED[f]?.[label]) continue;
      expect(src, `${f} has ${label}`).not.toMatch(re);
    }
  }
});

it("each navigation pattern matches its own sample and not a near miss", () => {
  const samples: Record<string, [string, string]> = {
    "a <form>": ["<form action=x>", "<formatted>"],
    "a location assignment": ["document.location = 'x'", "if (location.href == x) {}"],
    "a meta refresh": ['<meta http-equiv="refresh" content="0;url=x">', '<meta charset="utf-8">'],
    "a formaction": ['<button formaction="x">', "<button>"],
    ".submit()": ["f.submit()", "f.submitted = true"],
  };
  for (const [label, re] of NAVIGATION_PATTERNS) {
    const [hit, miss] = samples[label] ?? ["", ""];
    expect(re.test(hit), `${label} on its sample`).toBe(true);
    expect(re.test(miss), `${label} on a near miss`).toBe(false);
  }
  expect(NAVIGATION_PATTERNS[1]?.[1].test("location.href += 'x'")).toBe(true);
});

it("every allowlisted hit still exists", () => {
  const root = resolve(import.meta.dirname, "../../../app");
  const patterns = new Map(NAVIGATION_PATTERNS);
  for (const [f, labels] of Object.entries(ALLOWED))
    for (const label of Object.keys(labels)) {
      const re = patterns.get(label);
      expect(re, `${f}: unknown pattern ${label}`).toBeDefined();
      expect(re?.test(readFileSync(resolve(root, f), "utf8")), `${f} no longer has ${label}`).toBe(
        true,
      );
    }
});
