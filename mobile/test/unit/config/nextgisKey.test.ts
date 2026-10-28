import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import appConfig from "../../../app.config.js";

// A made-up key: the real one never appears in a test.
const KEY = "test-key/0";
const MOBILE = resolve(fileURLToPath(import.meta.url), "../../../..");

function extraWith(env: string | undefined) {
  if (env === undefined) delete process.env.NEXTGIS_OVERPASS_KEY;
  else process.env.NEXTGIS_OVERPASS_KEY = env;
  return appConfig({ config: {} } as never).extra;
}

afterEach(() => delete process.env.NEXTGIS_OVERPASS_KEY);

describe("app.config extra.nextgisOverpassKey", () => {
  it("carries the build's key to the app", () =>
    expect(extraWith(KEY)?.nextgisOverpassKey).toBe(KEY));

  it("is null when the variable is unset, so the app asks overpass-api.de alone", () =>
    expect(extraWith(undefined)?.nextgisOverpassKey).toBeNull());

  it("is null when the variable is empty", () =>
    expect(extraWith("")?.nextgisOverpassKey).toBeNull());
});

describe("WebShell hands the key to the page", () => {
  const source = readFileSync(resolve(MOBILE, "src/WebShell.tsx"), "utf8");

  it("reads extra.nextgisOverpassKey from the expo config", () =>
    expect(source).toMatch(
      /pageConfigScript\(\s*Constants\.expoConfig\?\.extra\?\.nextgisOverpassKey\s*\)/,
    ));

  it("injects that script before the page's own scripts run", () =>
    expect(source).toMatch(
      /\{\.\.\.\(pageConfig \? \{ injectedJavaScriptBeforeContentLoaded: pageConfig \} : \{\}\)\}/,
    ));
});
