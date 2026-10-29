import { afterEach, describe, expect, it, vi } from "vitest";
import { reportDropped } from "../../../src/bridge/dropped.js";
import {
  encode,
  inspectWebToNative,
  type NativeToWeb,
  parseNativeToWeb,
} from "../../../src/bridge/protocol.js";
import { COPY } from "../../../src/copy.js";

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
    expect(drop).toMatchObject({ type: "sendRoute", routeId });
    expect(drop.paths).toContain("route.coords.0.2");
    expect(drop.paths).toContain("route.coords.1");
  });

  it("gives no route id when the id itself is unreadable", () => {
    const drop = dropOf(
      JSON.stringify({ v: 1, type: "sendRoute", route: { ...route, id: "not-a-uuid" } }),
    );
    expect(drop).toMatchObject({ type: "sendRoute", routeId: null });
    expect(drop.paths).toContain("route.id");
  });

  it("gives no route id for a message that is not a sendRoute", () => {
    const drop = dropOf(JSON.stringify({ v: 1, type: "needTrack", activityId: 7, route }));
    expect(drop).toEqual({ type: "needTrack", paths: ["activityId"], activityId: null });
  });

  it("does not repeat a type the app does not know, since it could be any text", () => {
    expect(dropOf(JSON.stringify({ v: 1, type: `at ${SECRET_LAT}` }))).toEqual({
      type: null,
      reason: "unknown-type",
      paths: [],
    });
  });

  it("tells apart text that is not JSON, JSON that is not an object and an unknown type", () => {
    expect(dropOf("{not json")).toEqual({ type: null, reason: "json", paths: [] });
    expect(dropOf("null")).toEqual({ type: null, reason: "not-object", paths: [] });
    expect(dropOf("7")).toEqual({ type: null, reason: "not-object", paths: [] });
    expect(dropOf("[1]")).toEqual({ type: null, reason: "not-object", paths: [] });
    expect(dropOf("{}")).toEqual({ type: null, reason: "unknown-type", paths: [] });
  });

  it("gives the activity id of a dropped deleteActivity or needTrack when the id itself is valid", () => {
    for (const type of ["deleteActivity", "needTrack"] as const) {
      expect(dropOf(JSON.stringify({ v: 2, type, activityId }))).toEqual({
        type,
        paths: ["v"],
        activityId,
      });
    }
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
    expect(drop).toEqual({ type: "exportBinary", paths: ["(message)"], exportId: "e" });
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
    expect(drop).toMatchObject({ type: "exportBinary", exportId: null });
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

  it("tells the page a dropped delete failed, so the activity that stays in the list is explained", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: NativeToWeb[] = [];
    reportDropped(
      dropOf(JSON.stringify({ v: 2, type: "deleteActivity", activityId })),
      (m) => sent.push(m),
      () => {},
    );
    expect(sent).toEqual([{ v: 1, type: "notice", text: COPY.activityDeleteFailed }]);
    for (const m of sent) expect(parseNativeToWeb(encode(m))).toEqual(m);
  });

  it("answers a dropped track request with trackUnavailable, so the detail stops waiting", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: NativeToWeb[] = [];
    reportDropped(
      dropOf(JSON.stringify({ v: 2, type: "needTrack", activityId })),
      (m) => sent.push(m),
      () => {},
    );
    expect(sent).toEqual([{ v: 1, type: "trackUnavailable", activityId, reason: "readFailed" }]);
    for (const m of sent) expect(parseNativeToWeb(encode(m))).toEqual(m);
  });

  it("logs why a message with no known type was dropped, still without a value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportDropped(
      dropOf("{not json"),
      () => {},
      () => {},
    );
    reportDropped(
      dropOf("[1]"),
      () => {},
      () => {},
    );
    reportDropped(
      dropOf(JSON.stringify({ type: `at ${SECRET_LAT}` })),
      () => {},
      () => {},
    );
    const lines = warn.mock.calls.map((c) => c.join(" "));
    expect(lines[0]).toContain("unknown:json");
    expect(lines[1]).toContain("unknown:not-object");
    expect(lines[2]).toContain("unknown:unknown-type");
    expect(lines.join("\n")).not.toContain(String(SECRET_LAT));
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
    reportDropped(
      dropOf(JSON.stringify({ v: 1, type: "deleteActivity", activityId: "x" })),
      send,
      abandon,
    );
    reportDropped(dropOf("{not json"), send, abandon);
    expect(send).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
  });
});
