import { beforeEach, expect, it, vi } from "vitest";
import { installDevTools } from "../../web-adapter/devTools.js";
import type { FogCache } from "../../web-adapter/fogCache.js";
import type { StatusActions } from "../../web-adapter/status.js";
import { ageLabel, createStatus, formatDate, formatMb } from "../../web-adapter/status.js";
import { loadUpstreamDom } from "./support/upstreamDom.js";

const now = () => Date.parse("2026-10-01T12:00:00.000Z");
const line = () => document.getElementById("crossfogLine")!;
const hint = () => document.getElementById("hint")!;

let actions: StatusActions;
let status: ReturnType<typeof createStatus>;

beforeEach(() => {
  loadUpstreamDom(document);
  actions = { update: vi.fn(), clear: vi.fn(), about: vi.fn(), retry: vi.fn() };
  status = createStatus(document, actions, now);
});

it.each([
  [6, null],
  [7, "1 week old"],
  [13, "1 week old"],
  [14, "2 weeks old"],
  [59, "8 weeks old"],
  [60, "2 months old"],
  [400, "13 months old"],
])("ageLabel(%i) is %j", (days, label) => expect(ageLabel(days)).toBe(label));

it.each([
  ["2026-01-05T12:00:00.000Z", "5 Jan 2026"],
  ["2026-02-01T12:00:00.000Z", "1 Feb 2026"],
  ["2026-03-15T12:00:00.000Z", "15 Mar 2026"],
  ["2026-04-20T12:00:00.000Z", "20 Apr 2026"],
  ["2026-05-10T12:00:00.000Z", "10 May 2026"],
  ["2026-06-01T12:00:00.000Z", "1 Jun 2026"],
  ["2026-07-04T12:00:00.000Z", "4 Jul 2026"],
  ["2026-08-31T12:00:00.000Z", "31 Aug 2026"],
  ["2026-09-12T12:00:00.000Z", "12 Sep 2026"],
  ["2026-10-15T12:00:00.000Z", "15 Oct 2026"],
  ["2026-11-11T12:00:00.000Z", "11 Nov 2026"],
  ["2026-12-25T12:00:00.000Z", "25 Dec 2026"],
])("formatDate(%s) is %s", (iso, expected) => expect(formatDate(iso)).toBe(expected));

it.each([
  [0, "0.0"],
  [2_500_000, "2.5"],
  [9_900_000, "9.9"],
  [10_000_000, "10"],
  [12_400_000, "12"],
  [50_000_000, "50"],
])("formatMb(%i) is %s", (bytes, text) => expect(formatMb(bytes)).toBe(text));

it("shows the saved line right under #loadStatus", () => {
  status.showSaved({ name: "fog.zip", savedAt: "2026-09-28T12:00:00.000Z" });
  expect(document.getElementById("loadStatus")!.nextElementSibling!.id).toBe("crossfogStatus");
  expect(line().textContent).toContain("Saved backup fog.zip, imported 28 Sep 2026");
  expect(line().querySelector(".crossfog-stale")).toBeNull();
});

it("highlights a backup that is 7 days or more old", () => {
  status.showSaved({ name: "fog.zip", savedAt: "2026-09-10T12:00:00.000Z" });
  expect(line().querySelector(".crossfog-stale")!.textContent).toBe("10 Sep 2026 (3 weeks old)");
});

it("shows a hostile file name as text", () => {
  status.showSaved({
    name: "<img src=x onerror=alert(1)>.zip",
    savedAt: "2026-09-28T12:00:00.000Z",
  });
  expect(line().querySelector("img")).toBeNull();
  expect(line().textContent).toContain("<img src=x onerror=alert(1)>.zip");
});

it("wires every button to its action", () => {
  status.showSaved({ name: "fog.zip", savedAt: "2026-09-28T12:00:00.000Z" });
  const btns = line().querySelectorAll("button");
  btns.forEach((b) => {
    b.click();
  });
  expect(actions.update).toHaveBeenCalledOnce();
  expect(actions.clear).toHaveBeenCalledOnce();
  expect(actions.about).toHaveBeenCalledOnce();

  status.showRetry("failed");
  const retryBtns = line().querySelectorAll("button");
  retryBtns.forEach((b) => {
    b.click();
  });
  expect(actions.retry).toHaveBeenCalledOnce();
  // update called again (Choose another backup)
  expect(actions.update).toHaveBeenCalledTimes(2);
  // clear called again
  expect(actions.clear).toHaveBeenCalledTimes(2);
});

it("shows progress", () => {
  status.showProgress(12_400_000, 50_000_000);
  expect(line().textContent).toBe("Loading your fog… 12 / 50 MB");
});

it("shows progress in the header hint too, which stays visible when the panel is collapsed", () => {
  status.showProgress(12_400_000, 50_000_000);
  expect(hint().textContent).toBe("Loading… 12 / 50 MB");
});

it.each([
  ["saved", () => status.showSaved({ name: "a.zip", savedAt: "2026-10-01T09:00:00.000Z" })],
  ["retry", () => status.showRetry("failed")],
  ["hide", () => status.hide()],
] as const)("puts the header hint's own text back on %s", (_name, end) => {
  const original = hint().textContent;
  status.showProgress(3_000_000, 50_000_000);
  end();
  expect(hint().textContent).toBe(original);
});

it("does not mind a page without the header hint", () => {
  hint().remove();
  expect(() => status.showProgress(1, 2)).not.toThrow();
  expect(() => status.hide()).not.toThrow();
});

it.each([
  ["suspended", "Your saved fog couldn't be opened. The last attempt ran out of memory."],
  ["failed", "Your saved fog couldn't be opened."],
] as const)("shows the %s retry panel", (kind, text) => {
  status.showRetry(kind);
  expect(line().textContent).toContain(text);
});

it("hide keeps the notice", () => {
  status.showNotice("That file isn't a Fog of World backup. Your saved fog is unchanged.");
  status.hide();
  expect(document.getElementById("crossfogNotice")!.textContent).toBe(
    "That file isn't a Fog of World backup. Your saved fog is unchanged.",
  );
});

it("the dev button drops the cache", async () => {
  const cache: FogCache = {
    get: vi.fn(),
    putOnly: vi.fn(),
    clearAll: vi.fn().mockResolvedValue(undefined),
  };
  installDevTools(document, cache);
  const btn = document.querySelector("button[data-crossfog-dev]") as HTMLButtonElement;
  expect(btn).not.toBeNull();
  btn.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(cache.clearAll).toHaveBeenCalledOnce();
});
