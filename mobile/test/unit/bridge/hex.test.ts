import { describe, expect, it } from "vitest";
import { toHex } from "../../../src/bridge/hex.js";

describe("hex", () => {
  it("writes lowercase hex", () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
    expect(toHex(new Uint8Array([171]).buffer)).toBe("ab");
  });
});
