import { describe, expect, it } from "vitest";
import { checkedKeyHex, newDatabaseKeyHex } from "../../../src/db/keyHex.js";

describe("checkedKeyHex", () => {
  it("accepts 64 lowercase hex digits", () => {
    expect(checkedKeyHex("0123456789abcdef".repeat(4))).toBe("0123456789abcdef".repeat(4));
  });

  it.each([
    ["too short", "ab".repeat(31)],
    ["too long", "ab".repeat(33)],
    ["not hex", `${"ab".repeat(31)}zz`],
    ["upper case", "AB".repeat(32)],
    ["a quote", `${"ab".repeat(31)}'"`],
    ["empty", ""],
  ])("refuses a key that is %s", (_name, hex) => {
    expect(() => checkedKeyHex(hex)).toThrow("malformed database key");
  });
});

describe("newDatabaseKeyHex", () => {
  it("asks for 32 random bytes, returns them as hex and wipes them", () => {
    const asked: number[] = [];
    let given: Uint8Array | undefined;
    const hex = newDatabaseKeyHex((n) => {
      asked.push(n);
      given = Uint8Array.from({ length: n }, (_, i) => i + 1);
      return given;
    });
    expect(asked).toEqual([32]);
    expect(hex).toBe(
      Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, "0")).join(""),
    );
    expect(given?.every((b) => b === 0)).toBe(true);
  });

  it("refuses a source that gives the wrong number of bytes", () => {
    expect(() => newDatabaseKeyHex(() => new Uint8Array(16))).toThrow("malformed database key");
  });
});
