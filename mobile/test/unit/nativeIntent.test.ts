import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeIncoming } from "../../src/import/incomingQueue.js";

vi.mock("expo-share-intent", () => ({ getShareExtensionKey: () => "crossfogShareKey" }));

const queued: Array<{ uri: string; name: string }> = [];
subscribeIncoming((file) => queued.push(file));

beforeEach(() => {
  queued.length = 0;
});

const { redirectSystemPath } = await import("../../app/+native-intent.js");

describe("redirectSystemPath", () => {
  it("queues a file opened from another app and goes home", () => {
    expect(redirectSystemPath({ path: "file:///x/Documents/Inbox/fog.zip", initial: true })).toBe(
      "/",
    );
    expect(queued).toEqual([{ uri: "file:///x/Documents/Inbox/fog.zip", name: "fog.zip" }]);
  });

  it("leaves shares to the share-intent provider", () => {
    expect(
      redirectSystemPath({ path: "crossfog://dataUrl=crossfogShareKey", initial: false }),
    ).toBe("/");
    expect(queued).toEqual([]);
  });

  it("leaves other links alone", () =>
    expect(redirectSystemPath({ path: "/about", initial: false })).toBe("/about"));
});
