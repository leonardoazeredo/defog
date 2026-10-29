import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkedKeyHex, type DatabaseKeyHex } from "../../../src/db/keyHex.js";

const native = {
  getDatabaseKeyHex: vi.fn(),
  keyState: vi.fn(),
  keyPresence: vi.fn(),
  replaceLostDatabaseKey: vi.fn(),
  resetKeys: vi.fn(),
  createDocument: vi.fn(),
  copyToUri: vi.fn(),
  displayNameOf: vi.fn(),
  copyFromUri: vi.fn(),
  status: vi.fn(),
  pendingActivities: vi.fn(),
  readActivity: vi.fn(),
  release: vi.fn(),
  queueRoute: vi.fn(),
  addListener: vi.fn(),
};
vi.mock("../../../modules/watch-link", () => ({ default: native }));

const {
  getDatabaseKeyHex,
  keyState,
  keyPresence,
  replaceLostDatabaseKey,
  resetKeys,
  createDocument,
  copyToUri,
  displayNameOf,
  copyFromUri,
  KeyLostError,
  KeyUnavailableError,
  linkStatus,
  pendingActivities,
  readActivity,
  releaseActivity,
  queueRoute,
  onLinkEvent,
} = await import("../../../src/platform/watchLinkModule");

beforeEach(() => {
  for (const fn of Object.values(native)) fn.mockReset();
});

describe("getDatabaseKeyHex", () => {
  it("returns the native key when it is 64 lowercase hex characters", async () => {
    const hex = "0123456789abcdef".repeat(4);
    native.getDatabaseKeyHex.mockResolvedValue(hex);
    await expect(getDatabaseKeyHex()).resolves.toBe(hex);
  });

  it.each([
    ["too short", "ab".repeat(31)],
    ["too long", "ab".repeat(33)],
    ["not hex", `${"ab".repeat(31)}zz`],
    ["upper case", "AB".repeat(32)],
    ["empty", ""],
  ])("rejects a key that is %s", async (_name, hex) => {
    native.getDatabaseKeyHex.mockResolvedValue(hex);
    await expect(getDatabaseKeyHex()).rejects.toThrow("malformed database key");
  });

  it("turns the native lost-key code into KeyLostError", async () => {
    native.getDatabaseKeyHex.mockRejectedValue(
      Object.assign(new Error("x"), { code: "ERR_KEY_LOST" }),
    );
    const err = await getDatabaseKeyHex().catch((e) => e);
    expect(err).toBeInstanceOf(KeyLostError);
    expect(err.name).toBe("KeyLostError");
    expect(err.cause.code).toBe("ERR_KEY_LOST");
  });

  it("passes any other native failure through unchanged", async () => {
    const failure = Object.assign(new Error("no context"), { code: "ERR_NO_CONTEXT" });
    native.getDatabaseKeyHex.mockRejectedValue(failure);
    await expect(getDatabaseKeyHex()).rejects.toBe(failure);
  });
});

describe("a key the native side cannot reach now", () => {
  const unavailable = () =>
    Object.assign(new Error("cannot reach the database key"), {
      code: "ERR_KEY_UNAVAILABLE",
    });

  it.each([
    ["getDatabaseKeyHex", () => getDatabaseKeyHex(), native.getDatabaseKeyHex],
    ["keyState", () => keyState(), native.keyState],
    ["keyPresence", () => keyPresence(), native.keyPresence],
    ["resetKeys", () => resetKeys(), native.resetKeys],
    [
      "replaceLostDatabaseKey",
      () => replaceLostDatabaseKey(checkedKeyHex("ab".repeat(32))),
      native.replaceLostDatabaseKey,
    ],
  ] as const)("%s rejects with KeyUnavailableError, never KeyLostError", async (_n, call, fn) => {
    const failure = unavailable();
    fn.mockRejectedValue(failure);
    const err = await call().catch((e) => e);
    expect(err).toBeInstanceOf(KeyUnavailableError);
    expect(err).not.toBeInstanceOf(KeyLostError);
    expect(err.name).toBe("KeyUnavailableError");
    expect(err.cause).toBe(failure);
  });
});

describe("keyState", () => {
  it.each(["fresh", "existing", "lost", "unreadable"])("returns %s", async (state) => {
    native.keyState.mockResolvedValue(state);
    await expect(keyState()).resolves.toBe(state);
  });

  it("passes a native failure through unchanged", async () => {
    const failure = new Error("keystore busy");
    native.keyState.mockRejectedValue(failure);
    await expect(keyState()).rejects.toBe(failure);
  });

  it("rejects a state it does not know", async () => {
    native.keyState.mockResolvedValue("maybe");
    await expect(keyState()).rejects.toThrow("unknown key state");
  });
});

describe("keyPresence", () => {
  it.each(["fresh", "existing", "lost"])("returns %s", async (state) => {
    native.keyPresence.mockResolvedValue(state);
    await expect(keyPresence()).resolves.toBe(state);
  });

  it.each(["unreadable", "maybe"])("rejects %s, which it cannot tell", async (state) => {
    native.keyPresence.mockResolvedValue(state);
    await expect(keyPresence()).rejects.toThrow("unknown key state");
  });
});

describe("resetKeys", () => {
  it("forwards to the native reset", async () => {
    native.resetKeys.mockResolvedValue(undefined);
    await resetKeys();
    expect(native.resetKeys).toHaveBeenCalledExactlyOnceWith();
  });

  it("passes a native refusal through unchanged", async () => {
    const refusal = Object.assign(new Error("a database exists"), { code: "ERR_INVALID_STATE" });
    native.resetKeys.mockRejectedValue(refusal);
    await expect(resetKeys()).rejects.toBe(refusal);
  });
});

describe("staging and outbox calls", () => {
  it("forwards each call to the native function of the same job", async () => {
    native.status.mockResolvedValue({ paired: false });
    native.pendingActivities.mockResolvedValue([]);
    native.readActivity.mockResolvedValue("{}");
    native.release.mockResolvedValue(undefined);
    native.queueRoute.mockResolvedValue(undefined);
    await expect(linkStatus()).resolves.toEqual({ paired: false });
    await expect(pendingActivities()).resolves.toEqual([]);
    await expect(readActivity("a")).resolves.toBe("{}");
    await releaseActivity("a");
    await queueRoute("{}");
    expect(native.readActivity).toHaveBeenCalledWith("a");
    expect(native.release).toHaveBeenCalledWith("a");
    expect(native.queueRoute).toHaveBeenCalledWith("{}");
  });

  it("subscribes through addListener and unsubscribes through the subscription", () => {
    const remove = vi.fn();
    native.addListener.mockReturnValue({ remove });
    const fn = vi.fn();
    const off = onLinkEvent("routeSaved", fn);
    expect(native.addListener).toHaveBeenCalledWith("routeSaved", fn);
    expect(remove).not.toHaveBeenCalled();
    off();
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe("backup file functions", () => {
  it("hands the key to the native side to keep, and checks it again on the way", async () => {
    native.replaceLostDatabaseKey.mockResolvedValue(undefined);
    await replaceLostDatabaseKey(checkedKeyHex("ab".repeat(32)));
    expect(native.replaceLostDatabaseKey).toHaveBeenCalledExactlyOnceWith("ab".repeat(32));
    // Only a cast gets an unchecked string past the type.
    await expect(replaceLostDatabaseKey("AB".repeat(32) as DatabaseKeyHex)).rejects.toThrow(
      "malformed database key",
    );
    expect(native.replaceLostDatabaseKey).toHaveBeenCalledOnce();
  });

  it("passes the picker's answer through, null included", async () => {
    native.createDocument.mockResolvedValueOnce("content://x/1").mockResolvedValueOnce(null);
    await expect(createDocument("b.db", "application/octet-stream")).resolves.toBe("content://x/1");
    await expect(createDocument("b.db", "application/octet-stream")).resolves.toBeNull();
    expect(native.createDocument).toHaveBeenCalledWith("b.db", "application/octet-stream");
  });

  it("passes the provider's document name through", async () => {
    native.displayNameOf.mockResolvedValue("backup (1).db");
    await expect(displayNameOf("content://x/1")).resolves.toBe("backup (1).db");
  });

  it("passes the copy arguments through", async () => {
    native.copyToUri.mockResolvedValue(12);
    await expect(copyToUri("/cache/b.db", "content://x/1")).resolves.toBe(12);
    expect(native.copyToUri).toHaveBeenCalledWith("/cache/b.db", "content://x/1");
  });

  it("accepts a well-formed copy result", async () => {
    native.copyFromUri.mockResolvedValue({ size: 4096, head: "53514c69" });
    await expect(copyFromUri("content://x/1", "/cache/r.db")).resolves.toEqual({
      size: 4096,
      head: "53514c69",
    });
  });

  it.each([
    ["no size", { head: "00" }],
    ["a head that is not hex", { size: 1, head: "zz" }],
    ["a head that is too long", { size: 1, head: "00".repeat(17) }],
    ["nothing", undefined],
  ])("rejects a copy result with %s", async (_n, result) => {
    native.copyFromUri.mockResolvedValue(result);
    await expect(copyFromUri("u", "p")).rejects.toThrow("malformed copy result");
  });
});
