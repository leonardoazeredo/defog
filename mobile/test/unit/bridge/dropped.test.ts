import { afterEach, describe, expect, it, vi } from "vitest";
import { reportDropped } from "../../../src/bridge/dropped.js";
import {
  encode,
  inspectWebToNative,
  type NativeToWeb,
  parseNativeToWeb,
} from "../../../src/bridge/protocol.js";

const routeId = "6f1c1a52-3f1e-4c55-9d52-0a1d6c2b7e10";
const activityId = "0b9d8c1e-7a44-4f0b-8f3e-2d5c9a6b1f77";
// A place the owner went; it must never reach a log line.
const SECRET_LAT = 48.137154;

const route = {
  id: routeId,
  createdAt: "2026-10-01T09:00:00.000Z",
  mode: "loop",
  travelMode: "walk",
  waypoints: [
    { lat: SECRET_LAT, lng: 11.5 },
    { lat: SECRET_LAT, lng: 11.51 },
  ],
  coords: [
    [11.5, SECRET_LAT],
    [11.51, SECRET_LAT],
  ],
  stats: { distanceM: 700, seconds: 520, ascentM: 3, descentM: 4 },
  gpx: "<gpx/>",
};

const dropOf = (raw: string) => {
  const r = inspectWebToNative(raw);
  if (r.ok) throw new Error("expected the message to be dropped");
  return r.drop;
};

describe("inspectWebToNative", () => {
  it("passes a valid message through", () => {
    const msg = { v: 1 as const, type: "needTrack" as const, activityId };
    expect(inspectWebToNative(encode(msg))).toEqual({ ok: true, msg });
  });

  it("names the type and where a known message broke the schema", () => {
    const bad = { ...route, coords: [[11.5, SECRET_LAT, "high"], [11.51]] };
    const drop = dropOf(JSON.stringify({ v: 1, type: "sendRoute", route: bad }));
    expect(drop.type).toBe("sendRoute");
    expect(drop.paths).toContain("route.coords.0.2");
    expect(drop.paths).toContain("route.coords.1");
    expect(drop.routeId).toBe(routeId);
  });

  it("gives no route id when the id itself is unreadable", () => {
    const drop = dropOf(
      JSON.stringify({ v: 1, type: "sendRoute", route: { ...route, id: "not-a-uuid" } }),
    );
    expect(drop.routeId).toBeNull();
    expect(drop.paths).toContain("route.id");
  });

  it("gives no route id for a message that is not a sendRoute", () => {
    const drop = dropOf(JSON.stringify({ v: 1, type: "needTrack", activityId: 7, route }));
    expect(drop).toEqual({
      type: "needTrack",
      paths: ["activityId"],
      routeId: null,
      exportId: null,
    });
  });

  it("does not repeat a type the app does not know, since it could be any text", () => {
    expect(dropOf(JSON.stringify({ v: 1, type: `at ${SECRET_LAT}` }))).toEqual({
      type: null,
      paths: [],
      routeId: null,
      exportId: null,
    });
  });

  it("drops text that is not JSON with nothing to name", () => {
    const nothing = { type: null, paths: [], routeId: null, exportId: null };
    expect(dropOf("{not json")).toEqual(nothing);
    expect(dropOf("null")).toEqual(nothing);
  });

  it("names a broken cross-field check by the message", () => {
    const drop = dropOf(
      JSON.stringify({
        v: 1,
        type: "exportBinary",
        exportId: "e",
        name: "abcd",
        index: 3,
        total: 1,
        files: 1,
        data: "",
      }),
    );
    expect(drop).toEqual({
      type: "exportBinary",
      paths: ["(message)"],
      routeId: null,
      exportId: "e",
    });
  });

  it("gives no export id when the id itself would not be a safe path segment", () => {
    const drop = dropOf(
      JSON.stringify({
        v: 1,
        type: "exportBinary",
        exportId: "../x",
        name: "abcd",
        index: 0,
        total: 1,
        files: 1,
        data: "",
      }),
    );
    expect(drop.exportId).toBeNull();
    expect(drop.paths).toContain("exportId");
  });
});

describe("reportDropped", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the type and the paths, never a value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = { ...route, coords: [[11.5, SECRET_LAT, "high"], [11.51]] };
    reportDropped(
      dropOf(JSON.stringify({ v: 1, type: "sendRoute", route: bad })),
      () => {},
      () => {},
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]?.join(" ") ?? "";
    expect(line).toContain("sendRoute");
    expect(line).toContain("route.coords.0.2");
    expect(line).not.toContain(String(SECRET_LAT));
    expect(line).not.toContain("high");
  });

  it("tells the page a dropped route was not sent, so its chip does not stay blank", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: NativeToWeb[] = [];
    const bad = { ...route, stats: { ...route.stats, distanceM: -1 } };
    reportDropped(
      dropOf(JSON.stringify({ v: 1, type: "sendRoute", route: bad })),
      (m) => sent.push(m),
      () => {},
    );
    expect(sent).toEqual([{ v: 1, type: "routeStatus", routeId, state: "failed" }]);
    for (const m of sent) expect(parseNativeToWeb(encode(m))).toEqual(m);
  });

  it("abandons the export a dropped chunk belonged to, so it does not wait for the missing part", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const abandoned: string[] = [];
    const over = "A".repeat(Math.ceil(1_048_576 / 3) * 4 + 4);
    const raw = JSON.stringify({
      v: 1,
      type: "exportBinary",
      exportId: "e-1",
      name: "abcd",
      index: 0,
      total: 1,
      files: 1,
      data: over,
    });
    reportDropped(
      dropOf(raw),
      () => {},
      (id) => abandoned.push(id),
    );
    expect(abandoned).toEqual(["e-1"]);
  });

  it("answers nothing when there is no route id to answer", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn();
    const abandon = vi.fn();
    reportDropped(
      dropOf(JSON.stringify({ v: 1, type: "needTrack", activityId: "x" })),
      send,
      abandon,
    );
    reportDropped(dropOf("{not json"), send, abandon);
    expect(send).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
  });
});
