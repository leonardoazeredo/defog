import { beforeEach, expect, it } from "vitest";
import { installAttributionLift } from "../../web-adapter/attribution.js";
import { readUpstreamIndex } from "./support/upstreamDom.js";

const injected = () => document.head.querySelectorAll("style#crossfogAttribution");

beforeEach(() => {
  document.head.innerHTML = "";
});

it("lifts the bottom-right attribution above the collapsed and the open sheet", () => {
  installAttributionLift(document);
  expect(injected()).toHaveLength(1);
  const css = injected()[0]?.textContent ?? "";
  expect(css).toContain("@media (max-width: 720px)");
  expect(css).toContain(".leaflet-bottom.leaflet-right { bottom: 100px;");
  expect(css).toContain(
    "body:has(#sidebar.open) .leaflet-bottom.leaflet-right { bottom: 68vh; bottom: 68svh; }",
  );
});

it("injects the stylesheet once however often it is installed", () => {
  installAttributionLift(document);
  installAttributionLift(document);
  expect(injected()).toHaveLength(1);
});

it.each([["@media (max-width: 720px)"], ["--peek: 100px"], ["height: 68vh; height: 68svh"]])(
  "upstream still defines %s, which web-adapter/attribution.ts mirrors",
  (literal) =>
    expect(
      readUpstreamIndex(),
      `app/index.html no longer contains "${literal}": update web-adapter/attribution.ts to match`,
    ).toContain(literal),
);
