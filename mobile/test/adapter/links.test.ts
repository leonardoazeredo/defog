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
  for (const [type, listener] of added.splice(0))
    document.removeEventListener(type, listener, true);
});

function install(): unknown[] {
  const sent: unknown[] = [];
  installLinks(window, document, (m) => sent.push(m));
  return sent;
}

function click(el: Element, type = "click"): MouseEvent {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
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

it("intercepts the click a focused link gets from the Enter key", () => {
  const sent = install();
  pageAt(ORIGIN, '<a href="https://example.org/key">x</a>');
  const a = document.querySelector("a");
  if (a == null) throw new Error("no link rendered");
  a.focus();
  // Chromium turns Enter on a focused link into this same synthetic click.
  a.click();
  expect(sent).toEqual([{ v: 1, type: "openExternal", url: "https://example.org/key" }]);
});

it("leaves same-origin links alone and sends nothing", () => {
  const sent = install();
  pageAt(
    ORIGIN,
    `<a id="h" href="#">top</a><a id="p" href="/other">p</a><a id="abs" href="${ORIGIN}x?y=1#z">abs</a><a id="b" href="blob:${ORIGIN}0b1c">blob</a>`,
  );
  for (const id of ["h", "p", "abs", "b"]) {
    const a = document.getElementById(id);
    if (a == null) throw new Error("no link rendered");
    expect(click(a).defaultPrevented).toBe(false);
  }
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

it("ignores clicks that are not on a link", () => {
  const sent = install();
  pageAt(ORIGIN, '<button id="b">x</button><a name="anchor">no href</a>');
  for (const el of document.querySelectorAll("button, a"))
    expect(click(el).defaultPrevented).toBe(false);
  expect(sent).toEqual([]);
});

// Only a link click is intercepted here. A form submit or a location assignment would reach the WebView as a navigation that
// navigationPolicy alone can stop, and its answer can arrive late (#138). So the page must never make one; fail here when
// that changes.
it("app/ has no form and assigns no location, so only a link click can leave the page", () => {
  const root = resolve(import.meta.dirname, "../../../app");
  const files = [
    resolve(root, "index.html"),
    ...readdirSync(resolve(root, "src"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => resolve(root, "src", f)),
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    expect(src, f).not.toMatch(/<form[\s>]/i);
    expect(src, f).not.toMatch(
      /\blocation(\.(href|assign|replace))?\s*=[^=]|\blocation\.(assign|replace)\(/,
    );
  }
});
