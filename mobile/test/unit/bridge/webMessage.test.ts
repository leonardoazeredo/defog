import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encode,
  type NativeToWeb,
  ORIGIN,
  type WebToNative,
} from "../../../src/bridge/protocol.js";
import { createWebMessageHandler } from "../../../src/bridge/webMessage.js";

const activityId = "0b9d8c1e-7a44-4f0b-8f3e-2d5c9a6b1f77";

function setup() {
  const sent: NativeToWeb[] = [];
  const abandoned: string[] = [];
  const received: WebToNative[] = [];
  const handle = createWebMessageHandler({
    send: (m) => sent.push(m),
    abandonExport: (id) => abandoned.push(id),
    onMessage: (m) => {
      received.push(m);
    },
  });
  return { sent, abandoned, received, handle };
}

describe("createWebMessageHandler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hands a valid message from the page to the controller", () => {
    const { handle, received, sent } = setup();
    const msg = { v: 1 as const, type: "needTrack" as const, activityId };
    handle({ url: ORIGIN, data: encode(msg) });
    expect(received).toEqual([msg]);
    expect(sent).toEqual([]);
  });

  it("sends a message that fails the schema to reportDropped, not to the controller", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle, received, sent } = setup();
    handle({ url: ORIGIN, data: JSON.stringify({ v: 2, type: "needTrack", activityId }) });
    expect(received).toEqual([]);
    expect(sent).toEqual([{ v: 1, type: "trackUnavailable", activityId, reason: "readFailed" }]);
  });

  it("gives a dropped exportBinary's id to abandonExport", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle, abandoned } = setup();
    handle({
      url: ORIGIN,
      data: JSON.stringify({
        v: 1,
        type: "exportBinary",
        exportId: "e-1",
        name: "abcd",
        index: 5,
        total: 1,
        files: 1,
        data: "",
      }),
    });
    expect(abandoned).toEqual(["e-1"]);
  });

  it("ignores a message from another origin without logging or answering", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle, received, sent } = setup();
    handle({ url: "https://evil.example/", data: "{not json" });
    handle({ url: "https://evil.example/", data: encode({ v: 1, type: "ready" }) });
    expect(received).toEqual([]);
    expect(sent).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
