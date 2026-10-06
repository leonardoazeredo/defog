import { createHash } from "node:crypto";
import * as Crypto from "expo-crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/platform/sha256.js";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: vi.fn(
    async (_algorithm: string, data: Uint8Array) =>
      Uint8Array.from(createHash("sha256").update(data).digest()).buffer,
  ),
}));

beforeEach(() => {
  vi.mocked(Crypto.digest).mockClear();
});

it.each([
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
])("hashes %j to its SHA-256 hex digest", async (text, hex) =>
  expect(await sha256Hex(new TextEncoder().encode(text))).toBe(hex),
);

it("hands the bytes to the native digest as SHA-256 without copying them", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  await sha256Hex(bytes);
  expect(Crypto.digest).toHaveBeenCalledTimes(1);
  expect(Crypto.digest).toHaveBeenCalledWith("SHA-256", bytes);
  expect(vi.mocked(Crypto.digest).mock.calls[0]?.[1]).toBe(bytes);
});
