import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { encode, type NativeToWeb, type WebToNative } from "../../src/bridge/protocol.js";
import { installFakeUpstream } from "./support/fakeUpstream.js";
import { loadUpstreamDom } from "./support/upstreamDom.js";

// Boots web-adapter/index.ts the way the WebView does and posts native messages to it, since the
// forwards from window.crossfog to window.CrossfogPage are lines no other test reaches.
const ACTIVITY = "0b9d8c1e-7a44-4f0b-8f3e-2d5c9a6b1f77";
const EXPORT = "e-1";

const posted: WebToNative[] = [];
const page = {
  fogMap: { addCells: vi.fn(() => 0), clearOverlay: vi.fn() },
  fogChanged: vi.fn(),
  reveal: {
    RULES: { version: 1, maxAccuracyM: 1, maxGapS: 1, maxGapM: 1, halfWidthM: 1 },
    reveal: vi.fn(() => new Int32Array()),
  },
  history: {
    setActivities: vi.fn(),
    setTrack: vi.fn(),
    trackUnavailable: vi.fn(),
    setUnreadable: vi.fn(),
  },
  routeStatus: vi.fn(),
  linkStatus: vi.fn(),
  exportStatus: vi.fn(),
};

const fromNative = (msg: NativeToWeb) =>
  window.dispatchEvent(new MessageEvent("message", { data: encode(msg) }));

beforeAll(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("CRYPTO_SUBTLE", true);
  vi.stubGlobal("CACHE_ENABLED", false);
  vi.stubGlobal("__CROSSFOG_DEV_TOOLS__", false);
  loadUpstreamDom(document);
  installFakeUpstream(window, document);
  (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = {
    postMessage: (raw: string) => posted.push(JSON.parse(raw) as WebToNative),
  };
  (window as unknown as { CrossfogPage: unknown }).CrossfogPage = page;
  await import("../../web-adapter/index.js");
  document.dispatchEvent(new Event("DOMContentLoaded"));
  // `ready` goes out last, after the listeners are in.
  await vi.waitFor(() => expect(posted.some((m) => m.type === "ready")).toBe(true));
});

describe("web-adapter/index boot", () => {
  it("forwards trackUnavailable to the History panel and the history sync", () => {
    fromNative({ v: 1, type: "trackUnavailable", activityId: ACTIVITY, reason: "notFound" });
    expect(page.history.trackUnavailable).toHaveBeenCalledWith(ACTIVITY, "notFound");
  });

  it("forwards exportStatus to the page", () => {
    fromNative({ v: 1, type: "exportStatus", exportId: EXPORT, state: "saved" });
    expect(page.exportStatus).toHaveBeenCalledWith({ exportId: EXPORT, state: "saved" });
  });
});
