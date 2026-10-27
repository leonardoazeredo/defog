import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { pageConfigScript } from "../../../src/bridge/pageConfig.js";

// A made-up key: the real one never appears in a test.
const KEY = "test-key/0";

// Runs the script against a stand-in window; `events` gets each dispatched event's type with the
// key, as it stood then.
function run(script: string, events: string[][] = []): Record<string, unknown> {
  const window: Record<string, unknown> = {
    dispatchEvent: (e: Event) => events.push([e.type, String(window.crossfogNextgisKey)]),
  };
  expect(runInNewContext(script, { window, Event })).toBe(true);
  delete window.dispatchEvent;
  return window;
}

it("hands the page the NextGIS key", () =>
  expect(run(pageConfigScript(KEY) ?? "")).toEqual({ crossfogNextgisKey: KEY }));

it("tells a page already running that the key is in", () => {
  const events: string[][] = [];
  run(pageConfigScript(KEY) ?? "", events);
  expect(events).toEqual([["crossfog-nextgis-key", KEY]]);
});

it("keeps a key that has quotes or a line break as one string", () => {
  const odd = "a\"b'c\nd</script>";
  expect(run(pageConfigScript(odd) ?? "")).toEqual({ crossfogNextgisKey: odd });
});

it.each([undefined, null, "", 42])("injects nothing without a key (%s)", (key) =>
  expect(pageConfigScript(key)).toBeUndefined(),
);
