import { describe, expect, it } from "vitest";
import { decideNavigation, ORIGIN } from "../../../src/bridge/navigationPolicy.js";

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
