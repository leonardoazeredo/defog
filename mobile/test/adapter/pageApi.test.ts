import { beforeEach, expect, it, vi } from "vitest";
import type { ExportChunk, RouteRecord, WebToNative } from "../../src/bridge/protocol.js";
import { installPageApi } from "../../web-adapter/pageApi.js";

const routeId = "6f1c1a52-3f1e-4c55-9d52-0a1d6c2b7e10";
const activityId = "0b9d8c1e-7a44-4f0b-8f3e-2d5c9a6b1f77";

const route: RouteRecord = {
  id: routeId,
  createdAt: "2026-10-01T09:00:00.000Z",
  mode: "loop",
  travelMode: "walk",
  waypoints: [
    { lat: 10, lng: 20 },
    { lat: 10.01, lng: 20.01 },
  ],
  coords: [
    [20, 10],
    [20.01, 10.01],
  ],
  stats: { distanceM: 1000, seconds: 700, ascentM: null, descentM: null },
  gpx: "<gpx/>",
};

const chunk: ExportChunk = {
  exportId: "e1",
  name: "abcdef123456",
  index: 0,
  total: 1,
  files: 1,
  data: "AAEC",
};

const trackPayload = {
  activityId,
  index: 0,
  total: 1,
  points: [{ t: 1_700_000_000_000, lat: 10, lon: 20 }],
};

const win = window;
let sent: WebToNative[];

beforeEach(() => {
  delete win.crossfog;
  sent = [];
});

function install(handlers?: Parameters<typeof installPageApi>[2]) {
  const api = installPageApi(win, (m) => sent.push(m), handlers);
  const crossfog = win.crossfog;
  if (crossfog == null) throw new Error("window.crossfog was not installed");
  return { api, crossfog };
}

it("installs window.crossfog", () => {
  const { crossfog } = install();
  expect(Object.keys(crossfog).sort()).toEqual([
    "backup",
    "deleteActivity",
    "exportBinary",
    "needTrack",
    "on",
    "restore",
    "sendRoute",
  ]);
});

it("posts each call as exactly one message", () => {
  const { crossfog } = install();
  crossfog.sendRoute(route);
  crossfog.needTrack(activityId);
  crossfog.deleteActivity(activityId);
  crossfog.exportBinary(chunk);
  crossfog.backup();
  crossfog.restore();
  expect(sent).toEqual([
    { v: 1, type: "sendRoute", route },
    { v: 1, type: "needTrack", activityId },
    { v: 1, type: "deleteActivity", activityId },
    { v: 1, type: "exportBinary", ...chunk },
    { v: 1, type: "backup" },
    { v: 1, type: "restore" },
  ]);
});

it("keeps the envelope when a page passes extra keys in an export chunk", () => {
  const { crossfog } = install();
  crossfog.exportBinary({ ...chunk, type: "restore", v: 2 } as unknown as ExportChunk);
  expect(sent).toEqual([{ ...chunk, v: 1, type: "exportBinary" }]);
});

it("hands a track message to the track listener without the envelope", () => {
  const { api, crossfog } = install();
  const fn = vi.fn();
  crossfog.on("track", fn);
  api.dispatch({ v: 1, type: "track", ...trackPayload });
  expect(fn).toHaveBeenCalledExactlyOnceWith(trackPayload);
});

it("hands a trackUnavailable message to its listener without the envelope", () => {
  const { api, crossfog } = install();
  const fn = vi.fn();
  crossfog.on("trackUnavailable", fn);
  api.dispatch({ v: 1, type: "trackUnavailable", activityId, reason: "notFound" });
  expect(fn).toHaveBeenCalledExactlyOnceWith({ activityId, reason: "notFound" });
});

it("hands an unreadableActivities count to its listener without the envelope", () => {
  const { api, crossfog } = install();
  const fn = vi.fn();
  crossfog.on("unreadableActivities", fn);
  api.dispatch({ v: 1, type: "unreadableActivities", count: 2 });
  expect(fn).toHaveBeenCalledExactlyOnceWith({ count: 2 });
});

it("routes each native type only to its own listeners", () => {
  const { api, crossfog } = install();
  const heard: string[] = [];
  crossfog.on("routeStatus", () => heard.push("routeStatus"));
  crossfog.on("linkStatus", () => heard.push("linkStatus"));
  crossfog.on("activities", () => heard.push("activities"));
  crossfog.on("track", () => heard.push("track"));
  api.dispatch({ v: 1, type: "linkStatus", paired: true, reachable: false });
  api.dispatch({ v: 1, type: "routeStatus", routeId, state: "onWatch" });
  api.dispatch({ v: 1, type: "activities", items: [] });
  api.dispatch({ v: 1, type: "notice", text: "not for the page API" });
  expect(heard).toEqual(["linkStatus", "routeStatus", "activities"]);
});

it("stops calling a listener after off", () => {
  const { api, crossfog } = install();
  const fn = vi.fn();
  const off = crossfog.on("linkStatus", fn);
  api.dispatch({ v: 1, type: "linkStatus", paired: true, reachable: true });
  off();
  api.dispatch({ v: 1, type: "linkStatus", paired: false, reachable: false });
  expect(fn).toHaveBeenCalledTimes(1);
});

it("keeps registrations of the same function apart", () => {
  const { api, crossfog } = install();
  const fn = vi.fn();
  const offFirst = crossfog.on("activities", fn);
  crossfog.on("activities", fn);
  offFirst();
  api.dispatch({ v: 1, type: "activities", items: [] });
  expect(fn).toHaveBeenCalledTimes(1);
});

it("lets a listener remove itself while a message is dispatched", () => {
  const { api, crossfog } = install();
  const second = vi.fn();
  const off = crossfog.on("linkStatus", () => off());
  crossfog.on("linkStatus", second);
  api.dispatch({ v: 1, type: "linkStatus", paired: true, reachable: true });
  expect(second).toHaveBeenCalledTimes(1);
});

it("does not give a message to a listener added while it is dispatched", () => {
  const { api, crossfog } = install();
  const late = vi.fn();
  crossfog.on("linkStatus", () => {
    crossfog.on("linkStatus", late);
  });
  api.dispatch({ v: 1, type: "linkStatus", paired: true, reachable: true });
  expect(late).not.toHaveBeenCalled();
});

it("keeps dispatching when one listener throws", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { api, crossfog } = install();
  const after = vi.fn();
  crossfog.on("activities", () => {
    throw new Error("page bug");
  });
  crossfog.on("activities", after);
  api.dispatch({ v: 1, type: "activities", items: [] });
  expect(after).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledTimes(1);
  error.mockRestore();
});

it("registers the handlers given at install as listeners", () => {
  const onTrack = vi.fn();
  const { api } = install({ track: onTrack });
  api.dispatch({ v: 1, type: "track", ...trackPayload });
  expect(onTrack).toHaveBeenCalledExactlyOnceWith(trackPayload);
});
