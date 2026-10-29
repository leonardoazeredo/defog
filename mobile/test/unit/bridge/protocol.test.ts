import { describe, expect, it } from "vitest";
import {
  encode,
  isTrustedSource,
  ORIGIN,
  parseNativeToWeb,
  type RouteRecord,
} from "../../../src/bridge/protocol.js";
import { loadUpstream } from "../../support/loadUpstream.js";
import { parseWebToNative } from "../../support/parseWebToNative.js";

const fp = "a".repeat(64);
const routeId = "6f1c1a52-3f1e-4c55-9d52-0a1d6c2b7e10";
const activityId = "0b9d8c1e-7a44-4f0b-8f3e-2d5c9a6b1f77";

const route: RouteRecord = {
  id: routeId,
  createdAt: "2026-10-01T09:00:00.000Z",
  mode: "loop",
  travelMode: "walk",
  targetDistanceM: 5000,
  waypoints: [
    { lat: 10, lng: 20 },
    { lat: 10.01, lng: 20.01 },
  ],
  coords: [
    [20, 10, 5],
    [20.01, 10.01],
  ],
  stats: { distanceM: 5000, seconds: 3600, ascentM: 12, descentM: 10 },
  gpx: "<gpx/>",
};

const bareRoute: RouteRecord = {
  id: routeId,
  createdAt: "2026-10-01T09:00:00Z",
  mode: "p2p",
  travelMode: "bike",
  waypoints: route.waypoints,
  coords: [
    [20, 10],
    [20.01, 10.01],
  ],
  stats: { distanceM: 5000, seconds: null, ascentM: null, descentM: null },
  gpx: "",
};

const activity = {
  id: activityId,
  travelMode: "walk",
  startedAt: "2026-10-01T09:00:00.000Z",
  endedAt: "2026-10-01T10:00:00.000Z",
  routeId,
  stats: {
    durationS: 3600,
    distanceM: 5000,
    paceSPerKm: 720,
    steps: 6500,
    calories: 300,
    heartRateAvg: 110,
    heartRateMax: 140,
  },
};

const webSamples = [
  { v: 1 as const, type: "ready" as const },
  { v: 1 as const, type: "pickBackup" as const },
  { v: 1 as const, type: "needBytes" as const, fingerprint: fp },
  { v: 1 as const, type: "loaded" as const, fingerprint: fp, ok: true as const, tiles: 1 },
  { v: 1 as const, type: "loaded" as const, fingerprint: fp, ok: true as const, tiles: 2 },
  {
    v: 1 as const,
    type: "loaded" as const,
    fingerprint: fp,
    ok: false as const,
    reason: "unzip" as const,
  },
  {
    v: 1 as const,
    type: "loaded" as const,
    fingerprint: fp,
    ok: false as const,
    reason: "noTiles" as const,
  },
  {
    v: 1 as const,
    type: "loaded" as const,
    fingerprint: fp,
    ok: false as const,
    reason: "memory" as const,
  },
  {
    v: 1 as const,
    type: "loaded" as const,
    fingerprint: fp,
    ok: false as const,
    reason: "checksum" as const,
  },
  {
    v: 1 as const,
    type: "loaded" as const,
    fingerprint: fp,
    ok: false as const,
    reason: "unknown" as const,
  },
  { v: 1 as const, type: "clearSavedFog" as const },
  { v: 1 as const, type: "retryReload" as const },
  {
    v: 1 as const,
    type: "export" as const,
    filename: "a.gpx",
    mime: "application/gpx+xml",
    text: "data",
  },
  { v: 1 as const, type: "openExternal" as const, url: "https://example.com/" },
  { v: 1 as const, type: "openAbout" as const },
  { v: 1 as const, type: "back:result" as const, handled: true },
  { v: 1 as const, type: "sendRoute" as const, route },
  { v: 1 as const, type: "sendRoute" as const, route: bareRoute },
  { v: 1 as const, type: "needTrack" as const, activityId },
  { v: 1 as const, type: "deleteActivity" as const, activityId },
  {
    v: 1 as const,
    type: "exportBinary" as const,
    exportId: "fow-1",
    name: "ab12cd34",
    index: 0,
    total: 1,
    files: 1,
    data: "AAEC",
  },
  {
    v: 1 as const,
    type: "exportBinary" as const,
    exportId: "fow-1",
    name: "ab12cd35",
    index: 2,
    total: 3,
    files: 1,
    data: "",
  },
  { v: 1 as const, type: "backup" as const },
  { v: 1 as const, type: "restore" as const },
  { v: 1 as const, type: "settings" as const, json: '{"f2m_units":"metric"}' },
  { v: 1 as const, type: "settingsApplied" as const },
  { v: 1 as const, type: "devAddActivity" as const },
];

const nativeSamples = [
  {
    v: 1 as const,
    type: "reload" as const,
    fingerprint: fp,
    name: "a.zip",
    savedAt: "2026-10-01T09:00:00.000Z",
    size: 100,
    role: "current" as const,
  },
  {
    v: 1 as const,
    type: "reload" as const,
    fingerprint: fp,
    name: "a.zip",
    savedAt: "2026-10-01T09:00:00.000Z",
    size: 0,
    role: "pending" as const,
  },
  {
    v: 1 as const,
    type: "chunk" as const,
    fingerprint: fp,
    index: 0,
    total: 1,
    data: "",
  },
  {
    v: 1 as const,
    type: "chunk" as const,
    fingerprint: fp,
    index: 1,
    total: 3,
    data: "",
  },
  { v: 1 as const, type: "none" as const },
  {
    v: 1 as const,
    type: "reloadSuspended" as const,
    savedAt: "2026-10-01T09:00:00.000Z",
  },
  { v: 1 as const, type: "notice" as const, text: "hello" },
  { v: 1 as const, type: "back" as const },
  { v: 1 as const, type: "needSettings" as const },
  { v: 1 as const, type: "applySettings" as const, json: "{}" },
  { v: 1 as const, type: "routeStatus" as const, routeId, state: "waiting" as const },
  { v: 1 as const, type: "routeStatus" as const, routeId, state: "onWatch" as const },
  {
    v: 1 as const,
    type: "routeStatus" as const,
    routeId,
    state: "failed" as const,
    why: "watch unreachable",
  },
  { v: 1 as const, type: "linkStatus" as const, paired: true, reachable: false },
  { v: 1 as const, type: "trackUnavailable" as const, activityId, reason: "notFound" as const },
  { v: 1 as const, type: "trackUnavailable" as const, activityId, reason: "readFailed" as const },
  { v: 1 as const, type: "unreadableActivities" as const, count: 0 },
  { v: 1 as const, type: "unreadableActivities" as const, count: 3 },
  { v: 1 as const, type: "activities" as const, items: [] },
  { v: 1 as const, type: "activities" as const, items: [activity] },
  {
    v: 1 as const,
    type: "activities" as const,
    items: [
      {
        id: activityId,
        travelMode: "walk",
        startedAt: activity.startedAt,
        endedAt: activity.endedAt,
        stats: { durationS: 60, distanceM: 80 },
      },
    ],
  },
  {
    v: 1 as const,
    type: "track" as const,
    activityId,
    index: 0,
    total: 2,
    points: [
      { t: 1_700_000_000_000, lat: 10, lon: 20 },
      {
        t: 1_700_000_003_000,
        lat: 10.0001,
        lon: 20.0001,
        accuracy: 5,
        elevation: -3,
        speed: 1.4,
        heartRate: 110,
        steps: 4,
        cadence: 100,
      },
    ],
  },
  { v: 1 as const, type: "track" as const, activityId, index: 1, total: 2, points: [] },
  {
    v: 1 as const,
    type: "track" as const,
    activityId,
    index: 0,
    total: 1,
    points: [],
    route: {
      coords: [
        [20, 10, 55],
        [20.001, 10.001],
      ] as Array<[number, number, number?]>,
    },
  },
];

describe("protocol", () => {
  it("round-trips every message", () => {
    for (const m of webSamples) expect(parseWebToNative(encode(m))).toEqual(m);
    for (const m of nativeSamples) expect(parseNativeToWeb(encode(m))).toEqual(m);
  });

  it("refuses a settings message larger than the cap", () => {
    const big = JSON.stringify({ v: 1, type: "settings", json: "x".repeat(16_385) });
    expect(parseWebToNative(big)).toBeNull();
  });

  it.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ v: 2, type: "ready" })],
    ["an unknown type", JSON.stringify({ v: 1, type: "selfDestruct" })],
    ["a short fingerprint", JSON.stringify({ v: 1, type: "needBytes", fingerprint: "abc" })],
    [
      "an uppercase fingerprint",
      JSON.stringify({ v: 1, type: "needBytes", fingerprint: "A".repeat(64) }),
    ],
    ["ok without tiles", JSON.stringify({ v: 1, type: "loaded", fingerprint: fp, ok: true })],
    [
      "a failure without a reason",
      JSON.stringify({ v: 1, type: "loaded", fingerprint: fp, ok: false }),
    ],
    [
      "an unknown reason",
      JSON.stringify({ v: 1, type: "loaded", fingerprint: fp, ok: false, reason: "cosmic" }),
    ],
    [
      "a javascript: link",
      JSON.stringify({ v: 1, type: "openExternal", url: "javascript:alert(1)" }),
    ],
    [
      "an intent: link",
      JSON.stringify({ v: 1, type: "openExternal", url: "intent://scan#Intent;end" }),
    ],
    ["a file: link", JSON.stringify({ v: 1, type: "openExternal", url: "file:///etc/hosts" })],
    [
      "a route whose id is not a UUID",
      JSON.stringify({ v: 1, type: "sendRoute", route: { ...route, id: "route-1" } }),
    ],
    [
      "a route with one waypoint",
      JSON.stringify({
        v: 1,
        type: "sendRoute",
        route: { ...route, waypoints: [route.waypoints[0]] },
      }),
    ],
    [
      "a route with one coordinate",
      JSON.stringify({ v: 1, type: "sendRoute", route: { ...route, coords: [route.coords[0]] } }),
    ],
    [
      "a route with an unknown mode",
      JSON.stringify({ v: 1, type: "sendRoute", route: { ...route, mode: "circuit" } }),
    ],
    [
      "a route with a latitude off the globe",
      JSON.stringify({
        v: 1,
        type: "sendRoute",
        route: { ...route, waypoints: [{ lat: 91, lng: 0 }, route.waypoints[1]] },
      }),
    ],
    [
      "a route with a negative distance",
      JSON.stringify({
        v: 1,
        type: "sendRoute",
        route: { ...route, stats: { ...route.stats, distanceM: -1 } },
      }),
    ],
    [
      "a route with an empty travel mode",
      JSON.stringify({ v: 1, type: "sendRoute", route: { ...route, travelMode: "" } }),
    ],
    [
      "a route without a GPX",
      JSON.stringify({ v: 1, type: "sendRoute", route: { ...route, gpx: undefined } }),
    ],
    ["needTrack without an id", JSON.stringify({ v: 1, type: "needTrack" })],
    [
      "needTrack with an id that is not a UUID",
      JSON.stringify({ v: 1, type: "needTrack", activityId: "7" }),
    ],
    [
      "deleteActivity with an id that is not a UUID",
      JSON.stringify({ v: 1, type: "deleteActivity", activityId: "7" }),
    ],
    [
      "exportBinary data that is not base64",
      JSON.stringify({
        v: 1,
        type: "exportBinary",
        exportId: "e",
        name: "abcdef123456",
        index: 0,
        total: 1,
        files: 1,
        data: "@@",
      }),
    ],
    [
      "exportBinary with index equal to total",
      JSON.stringify({
        v: 1,
        type: "exportBinary",
        exportId: "e",
        name: "abcdef123456",
        index: 1,
        total: 1,
        files: 1,
        data: "",
      }),
    ],
    [
      "exportBinary with zero total",
      JSON.stringify({
        v: 1,
        type: "exportBinary",
        exportId: "e",
        name: "abcdef123456",
        index: 0,
        total: 0,
        files: 1,
        data: "",
      }),
    ],
    [
      "exportBinary with an empty name",
      JSON.stringify({
        v: 1,
        type: "exportBinary",
        exportId: "e",
        name: "",
        index: 0,
        total: 1,
        files: 1,
        data: "",
      }),
    ],
    [
      "exportBinary without an export id",
      JSON.stringify({
        v: 1,
        type: "exportBinary",
        name: "abcdef123456",
        index: 0,
        total: 1,
        files: 1,
        data: "",
      }),
    ],
    [
      "exportBinary over 1 MiB raw",
      JSON.stringify({
        v: 1,
        type: "exportBinary",
        exportId: "e",
        name: "abcdef123456",
        index: 0,
        total: 1,
        files: 1,
        data: "A".repeat(1_398_108),
      }),
    ],
    [
      "exportBinary data of many megabytes (must drop, not throw)",
      JSON.stringify({
        v: 1,
        type: "exportBinary",
        exportId: "e",
        name: "abcdef123456",
        index: 0,
        total: 1,
        files: 1,
        data: "A".repeat(8_000_000),
      }),
    ],
    ...[
      ["a path in the name", { name: "../abcdef123456" }],
      ["a dot in the name", { name: "ab.tile" }],
      ["a path in the export id", { exportId: "../e" }],
      ["an export id over 64 characters", { exportId: "e".repeat(65) }],
      ["zero files", { files: 0 }],
      ["more files than a zip without ZIP64 holds", { files: 65_535 }],
      ["more chunks than a file may have", { total: 1025, index: 0 }],
    ].map(
      ([what, over]) =>
        [
          `exportBinary with ${what as string}`,
          JSON.stringify({
            v: 1,
            type: "exportBinary",
            exportId: "e",
            name: "abcdef123456",
            index: 0,
            total: 1,
            files: 1,
            data: "",
            ...(over as object),
          }),
        ] as [string, string],
    ),
  ])("drops %s from the page", (_, raw) => expect(parseWebToNative(raw)).toBeNull());

  it.each([
    [
      "index equal to total",
      { v: 1, type: "chunk", fingerprint: fp, index: 2, total: 2, data: "" },
    ],
    ["zero total", { v: 1, type: "chunk", fingerprint: fp, index: 0, total: 0, data: "" }],
    ["non-base64 data", { v: 1, type: "chunk", fingerprint: fp, index: 0, total: 1, data: "@@" }],
    [
      "a negative size",
      {
        v: 1,
        type: "reload",
        fingerprint: fp,
        name: "a.zip",
        savedAt: "2026-10-01T09:00:00.000Z",
        size: -1,
        role: "current",
      },
    ],
    ["a vague date", { v: 1, type: "reloadSuspended", savedAt: "yesterday" }],
    ["an empty notice", { v: 1, type: "notice", text: "" }],
    ["a long notice", { v: 1, type: "notice", text: "x".repeat(501) }],
    ["a routeStatus with an unknown state", { v: 1, type: "routeStatus", routeId, state: "lost" }],
    [
      "a routeStatus whose id is not a UUID",
      { v: 1, type: "routeStatus", routeId: "r1", state: "waiting" },
    ],
    ["a linkStatus without reachable", { v: 1, type: "linkStatus", paired: true }],
    [
      "a linkStatus with a string flag",
      { v: 1, type: "linkStatus", paired: "yes", reachable: true },
    ],
    ["activities without items", { v: 1, type: "activities" }],
    [
      "an activity whose id is not a UUID",
      { v: 1, type: "activities", items: [{ ...activity, id: "a1" }] },
    ],
    [
      "an activity without stats",
      { v: 1, type: "activities", items: [{ ...activity, stats: undefined }] },
    ],
    [
      "a track with index equal to total",
      { v: 1, type: "track", activityId, index: 2, total: 2, points: [] },
    ],
    [
      "a track with zero total",
      { v: 1, type: "track", activityId, index: 0, total: 0, points: [] },
    ],
    [
      "a track with more than 2000 points",
      {
        v: 1,
        type: "track",
        activityId,
        index: 0,
        total: 1,
        points: Array.from({ length: 2001 }, (_, i) => ({ t: i, lat: 0, lon: 0 })),
      },
    ],
    [
      "a track whose route has one coordinate",
      {
        v: 1,
        type: "track",
        activityId,
        index: 0,
        total: 1,
        points: [],
        route: { coords: [[0, 0]] },
      },
    ],
    [
      "a track whose route has a longitude off the globe",
      {
        v: 1,
        type: "track",
        activityId,
        index: 0,
        total: 1,
        points: [],
        route: {
          coords: [
            [181, 0],
            [0, 0],
          ],
        },
      },
    ],
    [
      "a track point without a position",
      { v: 1, type: "track", activityId, index: 0, total: 1, points: [{ t: 1, lat: 0 }] },
    ],
    [
      "a track point with a longitude off the globe",
      { v: 1, type: "track", activityId, index: 0, total: 1, points: [{ t: 1, lat: 0, lon: 181 }] },
    ],
    ["a negative unreadable count", { v: 1, type: "unreadableActivities", count: -1 }],
    ["a fractional unreadable count", { v: 1, type: "unreadableActivities", count: 1.5 }],
  ])("drops %s from native", (_, msg) => expect(parseNativeToWeb(JSON.stringify(msg))).toBeNull());

  it("rejects fingerprints outside exact 64-char hex", () => {
    const tooLong = JSON.stringify({ v: 1, type: "needBytes", fingerprint: "a".repeat(65) });
    const tooShort = JSON.stringify({ v: 1, type: "needBytes", fingerprint: "a".repeat(63) });
    expect(parseWebToNative(tooLong)).toBeNull();
    expect(parseWebToNative(tooShort)).toBeNull();
  });

  it("rejects dates without exact ISO-8601 Z suffix", () => {
    const noZ = JSON.stringify({ v: 1, type: "reloadSuspended", savedAt: "2026-10-01T09:00:00" });
    const extra = JSON.stringify({
      v: 1,
      type: "reloadSuspended",
      savedAt: "2026-10-01T09:00:00.000Z!",
    });
    expect(parseNativeToWeb(noZ)).toBeNull();
    expect(parseNativeToWeb(extra)).toBeNull();
  });

  it.each([
    ["longitude first, as sent", [120, 10], true],
    ["latitude first", [10, 120], false],
    ["a longitude past 180", [181, 0], false],
    ["a latitude past 90", [0, 91], false],
  ])("checks route coords as [lon, lat]: %s", (_, pair, ok) => {
    const raw = JSON.stringify({
      v: 1,
      type: "sendRoute",
      route: { ...route, coords: [pair, [0, 0]] },
    });
    expect(parseWebToNative(raw) !== null).toBe(ok);
  });

  it("rejects an export chunk one character over the cap", () => {
    const raw = JSON.stringify({
      v: 1,
      type: "exportBinary",
      exportId: "e",
      name: "abcdef123456",
      index: 0,
      total: 1,
      files: 1,
      data: "A".repeat(1_398_105),
    });
    expect(parseWebToNative(raw)).toBeNull();
  });

  it("accepts a track of exactly 2000 points and an export chunk of exactly 1 MiB", () => {
    const track = {
      v: 1 as const,
      type: "track" as const,
      activityId,
      index: 0,
      total: 1,
      points: Array.from({ length: 2000 }, (_, i) => ({ t: i, lat: 0, lon: 0 })),
    };
    const chunk = {
      v: 1 as const,
      type: "exportBinary" as const,
      exportId: "e",
      name: "abcdef123456",
      index: 0,
      total: 1,
      files: 1,
      data: `${"A".repeat(1_398_102)}==`,
    };
    expect(parseNativeToWeb(encode(track))).toEqual(track);
    expect(parseWebToNative(encode(chunk))).toEqual(chunk);
  });

  it("rejects non-http(s) external links", () => {
    const ftp = JSON.stringify({ v: 1, type: "openExternal", url: "ftp://example.com/" });
    expect(parseWebToNative(ftp)).toBeNull();
  });

  it("trusts only the page at ORIGIN", () => {
    expect(isTrustedSource(ORIGIN)).toBe(true);
    expect(isTrustedSource(ORIGIN.slice(0, -1))).toBe(true); // Android omits trailing slash
    expect(isTrustedSource(`${ORIGIN}#plan`)).toBe(true);
    expect(isTrustedSource("https://crossfog.madera.codes/other")).toBe(false);
    expect(isTrustedSource("https://crossfog.madera.codes.evil.example/")).toBe(false);
    expect(isTrustedSource("http://crossfog.madera.codes/")).toBe(false);
    expect(isTrustedSource("about:blank")).toBe(false);
  });
});

describe("exportBinary against what the page really sends", () => {
  const up = loadUpstream();
  const chunk = (name: string, exportId: string) =>
    JSON.stringify({
      v: 1,
      type: "exportBinary",
      exportId,
      name,
      index: 0,
      total: 1,
      files: 1,
      data: "",
    });

  it("accepts the Fog of World tile name of every tile id it samples", () => {
    const ids = [0, 1, 9, 10, 99, 511, 512, 117_660, 262_143];
    for (let id = 0; id < 262_144; id += 997) ids.push(id);
    for (const id of ids) {
      expect(parseWebToNative(chunk(up.tileName(id), "e1")), `tile id ${id}`).not.toBeNull();
    }
  });

  it("accepts a version 4 UUID as the export id", () => {
    expect(parseWebToNative(chunk("abcd", "4a8c9ca7-0205-4821-81d7-9b02e4e3d80c"))).not.toBeNull();
  });
});

describe("limits and ranges", () => {
  const send = (r: object) => JSON.stringify({ v: 1, type: "sendRoute", route: r });
  const exportChunk = (over: object) =>
    JSON.stringify({
      v: 1,
      type: "exportBinary",
      exportId: "e",
      name: "abc",
      index: 0,
      total: 1,
      files: 1,
      data: "AAEC",
      ...over,
    });
  const point = { t: 1, lat: 0, lon: 0 };
  const track = (over: object, p: object = point) =>
    JSON.stringify({ v: 1, type: "track", activityId, index: 0, total: 1, points: [p], ...over });

  it("bounds the route a track carries at the same point cap as a sent route", () => {
    const coords = (n: number) => Array.from({ length: n }, () => [0, 0]);
    expect(parseNativeToWeb(track({ route: { coords: coords(100_000) } }))).not.toBeNull();
    expect(parseNativeToWeb(track({ route: { coords: coords(100_001) } }))).toBeNull();
  });

  it("accepts an export chunk of exactly 1 MiB decoded and no more", () => {
    // 1 MiB is 349,525 groups of 3 bytes plus 1 byte, so the last group is padded with "==".
    const full = `${"AAAA".repeat(349_525)}AA==`;
    expect(parseWebToNative(exportChunk({ data: full }))).not.toBeNull();
    expect(parseWebToNative(exportChunk({ data: `${"AAAA".repeat(349_525)}AAA=` }))).toBeNull();
  });

  it.each([
    ["a travel mode over 32 characters", { travelMode: "x".repeat(33) }],
    ["a negative target distance", { targetDistanceM: -1 }],
    ["a negative duration", { stats: { ...route.stats, seconds: -1 } }],
    ["a negative ascent", { stats: { ...route.stats, ascentM: -1 } }],
    ["a negative descent", { stats: { ...route.stats, descentM: -1 } }],
    ["a GPX over the cap", { gpx: "x".repeat(10_000_001) }],
    ["more coordinates than the cap", { coords: Array.from({ length: 100_001 }, () => [0, 0]) }],
    [
      "more waypoints than the cap",
      { waypoints: Array.from({ length: 501 }, () => ({ lat: 0, lng: 0 })) },
    ],
  ])("refuses a route with %s", (_, over) => {
    expect(parseWebToNative(send({ ...route, ...over }))).toBeNull();
  });

  it("accepts a route at the GPX, coordinate and waypoint caps", () => {
    const full = {
      ...route,
      gpx: "x".repeat(10_000_000),
      coords: Array.from({ length: 100_000 }, () => [0, 0]),
      waypoints: Array.from({ length: 500 }, () => ({ lat: 0, lng: 0 })),
    };
    expect(parseWebToNative(send(full))).not.toBeNull();
  });

  it.each([
    ["a fractional chunk index", { index: 0.5 }],
    ["a negative chunk index", { index: -1 }],
    ["a base64 string that is not a multiple of 4", { data: "AAE" }],
    ["base64 padding in the middle", { data: "AA==AAEC" }],
    ["more bytes than 1 MiB in 1398104 characters", { data: "A".repeat(1_398_104) }],
  ])("refuses an export chunk with %s", (_, over) => {
    expect(parseWebToNative(exportChunk(over))).toBeNull();
  });

  it("refuses a route status reason over 500 characters", () => {
    const msg = { v: 1, type: "routeStatus", routeId, state: "failed", why: "x".repeat(501) };
    expect(parseNativeToWeb(JSON.stringify(msg))).toBeNull();
  });

  it.each([
    ["a bad start date", { startedAt: "yesterday" }],
    ["a bad end date", { endedAt: "2026-10-01 10:00:00" }],
    ["a negative duration", { stats: { ...activity.stats, durationS: -1 } }],
    ["a negative distance", { stats: { ...activity.stats, distanceM: -1 } }],
    ["a travel mode over 32 characters", { travelMode: "x".repeat(33) }],
  ])("refuses an activity with %s", (_, over) => {
    const msg = { v: 1, type: "activities", items: [{ ...activity, ...over }] };
    expect(parseNativeToWeb(JSON.stringify(msg))).toBeNull();
  });

  it.each([
    ["a negative index", track({ index: -1 })],
    ["a fractional index", track({ index: 0.5 })],
    ["an index past the total", track({ index: 1 })],
    ["a latitude of 91", track({}, { ...point, lat: 91 })],
    ["a negative time", track({}, { ...point, t: -1 })],
  ])("refuses a track chunk with %s", (_, raw) => {
    expect(parseNativeToWeb(raw)).toBeNull();
  });
});
