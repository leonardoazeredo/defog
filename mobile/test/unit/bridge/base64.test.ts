import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "../../../src/bridge/base64.js";

describe("base64", () => {
  it.each([
    [[0, 1, 2], "AAEC"],
    [[77, 97, 110], "TWFu"],
    [[77, 97], "TWE="],
    [[77], "TQ=="],
    [[], ""],
  ])("encodes %j", (bytes, text) => {
    expect(encodeBase64(new Uint8Array(bytes))).toBe(text);
    expect([...decodeBase64(text)]).toEqual(bytes);
  });

  it("matches Node for random bytes", () => {
    const bytes = randomBytes(1000);
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(decodeBase64(encodeBase64(bytes))).toEqual(new Uint8Array(bytes));
  });

  it("rejects invalid text", () => expect(() => decodeBase64("@@@@")).toThrow());

  it("rejects = in padding data position", () => expect(() => decodeBase64("A===")).toThrow());
});
