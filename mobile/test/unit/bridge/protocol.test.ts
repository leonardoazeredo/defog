import { describe, expect, it } from "vitest";
import {
  encode,
  isTrustedSource,
  ORIGIN,
  parseNativeToWeb,
  parseWebToNative,
} from "../../../src/bridge/protocol.js";

const fp = "a".repeat(64);

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
  { v: 1 as const, type: "retryRestore" as const },
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
];

const nativeSamples = [
  {
    v: 1 as const,
    type: "restore" as const,
    fingerprint: fp,
    name: "a.zip",
    savedAt: "2026-10-01T09:00:00.000Z",
    size: 100,
    role: "current" as const,
  },
  {
    v: 1 as const,
    type: "restore" as const,
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
    type: "restoreSuspended" as const,
    savedAt: "2026-10-01T09:00:00.000Z",
  },
  { v: 1 as const, type: "notice" as const, text: "hello" },
  { v: 1 as const, type: "back" as const },
];

describe("protocol", () => {
  it("round-trips every message", () => {
    for (const m of webSamples) expect(parseWebToNative(encode(m))).toEqual(m);
    for (const m of nativeSamples) expect(parseNativeToWeb(encode(m))).toEqual(m);
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
        type: "restore",
        fingerprint: fp,
        name: "a.zip",
        savedAt: "2026-10-01T09:00:00.000Z",
        size: -1,
        role: "current",
      },
    ],
    ["a vague date", { v: 1, type: "restoreSuspended", savedAt: "yesterday" }],
    ["an empty notice", { v: 1, type: "notice", text: "" }],
    ["a long notice", { v: 1, type: "notice", text: "x".repeat(501) }],
  ])("drops %s from native", (_, msg) => expect(parseNativeToWeb(JSON.stringify(msg))).toBeNull());

  it("rejects fingerprints outside exact 64-char hex", () => {
    const tooLong = JSON.stringify({ v: 1, type: "needBytes", fingerprint: "a".repeat(65) });
    const tooShort = JSON.stringify({ v: 1, type: "needBytes", fingerprint: "a".repeat(63) });
    expect(parseWebToNative(tooLong)).toBeNull();
    expect(parseWebToNative(tooShort)).toBeNull();
  });

  it("rejects dates without exact ISO-8601 Z suffix", () => {
    const noZ = JSON.stringify({ v: 1, type: "restoreSuspended", savedAt: "2026-10-01T09:00:00" });
    const extra = JSON.stringify({
      v: 1,
      type: "restoreSuspended",
      savedAt: "2026-10-01T09:00:00.000Z!",
    });
    expect(parseNativeToWeb(noZ)).toBeNull();
    expect(parseNativeToWeb(extra)).toBeNull();
  });

  it("rejects non-http(s) external links", () => {
    const ftp = JSON.stringify({ v: 1, type: "openExternal", url: "ftp://example.com/" });
    expect(parseWebToNative(ftp)).toBeNull();
  });

  it("trusts only the page at ORIGIN", () => {
    expect(isTrustedSource(ORIGIN)).toBe(true);
    expect(isTrustedSource(`${ORIGIN}#plan`)).toBe(true);
    expect(isTrustedSource("https://crossfog.madera.codes/other")).toBe(false);
    expect(isTrustedSource("https://crossfog.madera.codes.evil.example/")).toBe(false);
    expect(isTrustedSource("http://crossfog.madera.codes/")).toBe(false);
    expect(isTrustedSource("about:blank")).toBe(false);
  });
});
