import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { installLinks } from "../../web-adapter/links.js";

it("opens the attribution's copyright link in the system browser", () => {
  const sent: unknown[] = [];
  installLinks(window, document, (m) => sent.push(m));
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
