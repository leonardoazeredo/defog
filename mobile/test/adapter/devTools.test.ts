import { expect, it, vi } from "vitest";
import { installDevTools } from "../../web-adapter/devTools.js";
import type { FogCache } from "../../web-adapter/fogCache.js";

function setup() {
  document.body.innerHTML = "";
  const cache = { clearAll: vi.fn(() => Promise.resolve()) } as unknown as FogCache;
  const send = vi.fn();
  installDevTools(document, cache, send);
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[data-crossfog-dev]")];
  return { cache, send, buttons };
}

it("adds the drop-cache button and the add-activity button", () => {
  const { buttons } = setup();
  expect(buttons.map((b) => b.textContent)).toEqual([
    "Dev: drop fog cache",
    "Dev: add activity from GPX",
  ]);
});

it("sends nothing when the drop-cache button is tapped", () => {
  const { buttons, send, cache } = setup();
  buttons.find((b) => b.textContent === "Dev: drop fog cache")?.click();
  expect(cache.clearAll).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});

it("asks native to add an activity when its button is tapped", () => {
  const { buttons, send, cache } = setup();
  const add = buttons.find((b) => b.textContent === "Dev: add activity from GPX");
  add?.click();
  expect(send).toHaveBeenCalledExactlyOnceWith({ v: 1, type: "devAddActivity" });
  expect(cache.clearAll).not.toHaveBeenCalled();
});
