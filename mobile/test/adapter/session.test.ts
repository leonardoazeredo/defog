import { createHash } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { encodeBase64 } from "../../src/bridge/base64.js";
import type { NativeToWeb, WebToNative } from "../../src/bridge/protocol.js";
import type { FogCache } from "../../web-adapter/fogCache.js";
import type { LoadOutcome } from "../../web-adapter/loader.js";
import { createSession, createStatusActions } from "../../web-adapter/session.js";
import type { Status } from "../../web-adapter/status.js";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

const bytes = new Uint8Array([1, 2, 3, 4, 5]);
const fp = await sha256Hex(bytes);
const name = "fog.zip";
const savedAt = "2026-09-28T12:00:00.000Z";
const size = bytes.length;

function chunkMessages(b: Uint8Array, fp: string): NativeToWeb[] {
  return [{ v: 1, type: "chunk", fingerprint: fp, index: 0, total: 1, data: encodeBase64(b) }];
}

function makeCache(data: Map<string, Uint8Array> = new Map()): FogCache {
  const store = new Map(data);
  return {
    get: async (k) => store.get(k) ?? null,
    putOnly: async (k, v) => {
      store.clear();
      store.set(k, v);
    },
    clearAll: async () => store.clear(),
  };
}

function makeStatus(): Status & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push([method, ...args]);
    };
  return {
    calls,
    showSaved: rec("showSaved") as Status["showSaved"],
    showProgress: rec("showProgress") as Status["showProgress"],
    showRetry: rec("showRetry") as Status["showRetry"],
    showNotice: rec("showNotice") as Status["showNotice"],
    hide: rec("hide") as Status["hide"],
  };
}

let sent: WebToNative[];
let cache: FogCache;
let status: Status & { calls: unknown[][] };
let loadOutcomes: LoadOutcome[];

beforeEach(() => {
  sent = [];
  cache = makeCache();
  status = makeStatus();
  loadOutcomes = [];
});

function makeSession(loadOutcomeQueue?: LoadOutcome[]) {
  const queue = loadOutcomeQueue ?? loadOutcomes;
  return createSession({
    send: (m) => sent.push(m),
    cache,
    status,
    load: async () => queue.shift() ?? { ok: true, tiles: 2 },
    sha256Hex,
    handleBack: () => true,
  });
}

it("createStatusActions wires all four actions to protocol messages", () => {
  const isolated: WebToNative[] = [];
  const actions = createStatusActions((m) => isolated.push(m));
  actions.update();
  actions.clear();
  actions.about();
  actions.retry();
  expect(isolated).toEqual([
    { v: 1, type: "pickBackup" },
    { v: 1, type: "clearSavedFog" },
    { v: 1, type: "openAbout" },
    { v: 1, type: "retryRestore" },
  ]);
});

it("shows partial progress as chunks arrive", async () => {
  const bigBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const bigFp = await sha256Hex(bigBytes);
  function bigChunk(index: number): NativeToWeb {
    return {
      v: 1,
      type: "chunk",
      fingerprint: bigFp,
      index,
      total: 2,
      data: encodeBase64(bigBytes.slice(index * 3, (index + 1) * 3)),
    };
  }
  loadOutcomes = [{ ok: true, tiles: 1 }];
  const sess = makeSession();
  await sess.onMessage({
    v: 1,
    type: "restore",
    fingerprint: bigFp,
    name,
    savedAt,
    size: bigBytes.length,
    role: "current",
  });
  expect(status.calls).toContainEqual(["showProgress", 0, bigBytes.length]);
  await sess.onMessage(bigChunk(0));
  expect(status.calls).toContainEqual(["showProgress", 3, bigBytes.length]);
  await sess.onMessage(bigChunk(1));
  expect(sent).toContainEqual({ v: 1, type: "loaded", fingerprint: bigFp, ok: true, tiles: 1 });
});

it("sends exactly one retry needBytes on the first mismatch", async () => {
  const sess = makeSession();
  await sess.onMessage({
    v: 1,
    type: "restore",
    fingerprint: fp,
    name,
    savedAt,
    size,
    role: "current",
  });
  const badChunk: NativeToWeb = {
    v: 1,
    type: "chunk",
    fingerprint: fp,
    index: 0,
    total: 1,
    data: encodeBase64(new Uint8Array([9])),
  };
  await sess.onMessage(badChunk);
  expect(sent.filter((m) => m.type === "needBytes")).toHaveLength(2);
  expect(sent.filter((m) => m.type === "loaded")).toHaveLength(0);
});

it("first run: none empties the cache and hides the line", async () => {
  const c = makeCache(new Map([[fp, bytes]]));
  const sess = createSession({
    send: (m) => sent.push(m),
    cache: c,
    status,
    load: async () => ({ ok: true, tiles: 2 }),
    sha256Hex,
    handleBack: () => false,
  });
  await sess.onMessage({ v: 1, type: "none" });
  expect(await c.get(fp)).toBeNull();
  expect(status.calls).toContainEqual(["hide"]);
  expect(sent).toEqual([]);
});

it("restores from the cache without asking native", async () => {
  cache = makeCache(new Map([[fp, bytes]]));
  loadOutcomes = [{ ok: true, tiles: 2 }];
  const sess = makeSession();
  await sess.onMessage({
    v: 1,
    type: "restore",
    fingerprint: fp,
    name,
    savedAt,
    size,
    role: "current",
  });
  expect(sent).toEqual([{ v: 1, type: "loaded", fingerprint: fp, ok: true, tiles: 2 }]);
  expect(status.calls).toContainEqual(["showSaved", { name, savedAt }]);
});

it("asks for the bytes on a miss, and caches them after a good load", async () => {
  const OLD = "0".repeat(64);
  cache = makeCache(new Map([[OLD, new Uint8Array([9])]]));
  loadOutcomes = [{ ok: true, tiles: 2 }];
  const sess = makeSession();
  await sess.onMessage({
    v: 1,
    type: "restore",
    fingerprint: fp,
    name,
    savedAt,
    size,
    role: "pending",
  });
  expect(sent[0]).toEqual({ v: 1, type: "needBytes", fingerprint: fp });
  for (const chunk of chunkMessages(bytes, fp)) {
    await sess.onMessage(chunk);
  }
  expect(sent).toContainEqual({ v: 1, type: "loaded", fingerprint: fp, ok: true, tiles: 2 });
  expect(await cache.get(fp)).toEqual(bytes);
  expect(await cache.get(OLD)).toBeNull();
});

it("a failed import leaves the old cache entry alone", async () => {
  const OLD = "0".repeat(64);
  const oldBytes = new Uint8Array([9]);
  cache = makeCache(new Map([[OLD, oldBytes]]));
  loadOutcomes = [{ ok: false, reason: "noTiles" }];
  const sess = makeSession();
  await sess.onMessage({
    v: 1,
    type: "restore",
    fingerprint: fp,
    name,
    savedAt,
    size,
    role: "pending",
  });
  for (const chunk of chunkMessages(bytes, fp)) {
    await sess.onMessage(chunk);
  }
  expect(sent).toContainEqual({
    v: 1,
    type: "loaded",
    fingerprint: fp,
    ok: false,
    reason: "noTiles",
  });
  expect(await cache.get(OLD)).toEqual(oldBytes);
  expect(status.calls.map((c) => c[0])).not.toContain("showRetry");
});

it("a failed saved copy shows the retry panel", async () => {
  loadOutcomes = [{ ok: false, reason: "noTiles" }];
  cache = makeCache(new Map([[fp, bytes]]));
  const sess = makeSession();
  await sess.onMessage({
    v: 1,
    type: "restore",
    fingerprint: fp,
    name,
    savedAt,
    size,
    role: "current",
  });
  expect(status.calls).toContainEqual(["showRetry", "failed"]);
});

it("retries a checksum mismatch once, then reports checksum", async () => {
  const sess = makeSession();
  await sess.onMessage({
    v: 1,
    type: "restore",
    fingerprint: fp,
    name,
    savedAt,
    size,
    role: "current",
  });
  // wrong data triggers a checksum mismatch in the receiver
  const badChunk: NativeToWeb = {
    v: 1,
    type: "chunk",
    fingerprint: fp,
    index: 0,
    total: 1,
    data: encodeBase64(new Uint8Array([9])),
  };
  await sess.onMessage(badChunk);
  const needBytesCount = sent.filter((m) => m.type === "needBytes").length;
  expect(needBytesCount).toBeGreaterThanOrEqual(1);
  await sess.onMessage(badChunk);
  expect(sent).toContainEqual({
    v: 1,
    type: "loaded",
    fingerprint: fp,
    ok: false,
    reason: "checksum",
  });
});

it("ignores chunks for another fingerprint when active", async () => {
  const sess = makeSession();
  await sess.onMessage({
    v: 1,
    type: "restore",
    fingerprint: fp,
    name,
    savedAt,
    size,
    role: "current",
  });
  const otherFp = "c".repeat(64);
  await sess.onMessage({
    v: 1,
    type: "chunk",
    fingerprint: otherFp,
    index: 0,
    total: 1,
    data: encodeBase64(bytes),
  });
  expect(sent.filter((m) => m.type === "loaded")).toHaveLength(0);
});

it("restoreSuspended shows the suspended panel", async () => {
  const sess = makeSession();
  await sess.onMessage({ v: 1, type: "restoreSuspended", savedAt });
  expect(status.calls).toContainEqual(["showRetry", "suspended"]);
});

it("notice shows its text", async () => {
  const sess = makeSession();
  await sess.onMessage({ v: 1, type: "notice", text: "Hello!" });
  expect(status.calls).toContainEqual(["showNotice", "Hello!"]);
});

it("back reports whether the sheet closed", async () => {
  const sess = createSession({
    send: (m) => sent.push(m),
    cache,
    status,
    load: async () => ({ ok: true, tiles: 2 }),
    sha256Hex,
    handleBack: () => true,
  });
  await sess.onMessage({ v: 1, type: "back" });
  expect(sent).toContainEqual({ v: 1, type: "back:result", handled: true });

  const sess2 = createSession({
    send: (m) => sent.push(m),
    cache,
    status,
    load: async () => ({ ok: true, tiles: 2 }),
    sha256Hex,
    handleBack: () => false,
  });
  await sess2.onMessage({ v: 1, type: "back" });
  expect(sent).toContainEqual({ v: 1, type: "back:result", handled: false });
});
