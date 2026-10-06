import { describe, expect, it } from "vitest";
import {
  decideNavigation,
  ORIGIN,
  shouldOpenWindowExternally,
} from "../../../src/bridge/navigationPolicy.js";

describe("decideNavigation", () => {
  it.each([
    ["about:blank", false, "allow"],
    [ORIGIN, false, "allow"],
    [ORIGIN, true, "block"],
    ["about:blank", true, "block"],
    ["https://crossfog.madera.codes/other", false, "block"],
    ["https://www.google.com/maps/dir/?api=1", true, "external"],
    ["http://example.org/", true, "external"],
    ["blob:https://crossfog.madera.codes/1234", true, "block"],
    ["intent://scan#Intent;end", true, "block"],
    ["file:///etc/hosts", false, "block"],
    ["data:text/html,hi", false, "block"],
  ] as const)("%s (initialLoadDone: %s) → %s", (url, done, decision) =>
    expect(decideNavigation(url, done)).toBe(decision),
  );
});

describe("shouldOpenWindowExternally", () => {
  it.each([
    ["https://www.google.com/maps/dir/?api=1", true],
    ["https://drive.google.com", true],
    ["http://example.org/", true],
    [ORIGIN, false],
    [`${ORIGIN}x`, false],
    ["HTTPS://EXAMPLE.COM", false],
    ["javascript:alert(1)", false],
    ["intent://scan#Intent;end", false],
    ["file:///etc/hosts", false],
    ["data:text/html,hi", false],
    ["blob:https://crossfog.madera.codes/1", false],
    ["about:blank", false],
    ["", false],
  ] as const)("%s → %s", (url, external) => expect(shouldOpenWindowExternally(url)).toBe(external));
});
