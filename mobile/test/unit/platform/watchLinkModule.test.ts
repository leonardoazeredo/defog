import { beforeEach, describe, expect, it, vi } from "vitest";

const native = { getDatabaseKeyHex: vi.fn(), keyState: vi.fn() };
vi.mock("../../../modules/watch-link", () => ({ default: native }));

const { getDatabaseKeyHex, keyState, KeyLostError } = await import(
  "../../../src/platform/watchLinkModule"
);

beforeEach(() => {
  native.getDatabaseKeyHex.mockReset();
  native.keyState.mockReset();
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
