import { beforeEach, describe, expect, it, vi } from "vitest";

const native = {
  getDatabaseKeyHex: vi.fn(),
  keyState: vi.fn(),
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
  KeyLostError,
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

describe("keyState", () => {
  it.each(["fresh", "existing", "lost"])("returns %s", async (state) => {
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
