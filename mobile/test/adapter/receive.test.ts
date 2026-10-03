import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { encodeBase64 } from "../../src/bridge/base64.js";
import type { ChunkMessage } from "../../src/bridge/protocol.js";
import { createReceiver } from "../../web-adapter/receive.js";

const bytes9 = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90]);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

const fp9 = await sha256Hex(bytes9);

function chunksOf(bytes: Uint8Array, size: number): ChunkMessage[] {
  const total = Math.ceil(bytes.length / size);
  const chunks: ChunkMessage[] = [];
  for (let i = 0; i < total; i++) {
    chunks.push({
      v: 1,
      type: "chunk",
      fingerprint: fp9,
      index: i,
      total,
      data: encodeBase64(bytes.slice(i * size, (i + 1) * size)),
    });
  }
  return chunks;
}

it("reassembles chunks in order", async () => {
  const [c0, c1, c2] = chunksOf(bytes9, 3) as [ChunkMessage, ChunkMessage, ChunkMessage];
  const r = createReceiver(fp9, sha256Hex);
  expect(await r.accept(c0)).toEqual({ kind: "partial", receivedBytes: 3 });
  expect(await r.accept(c1)).toEqual({ kind: "partial", receivedBytes: 6 });
  expect(await r.accept(c2)).toEqual({ kind: "complete", bytes: bytes9 });
});

it("reassembles chunks out of order", async () => {
  const [c0, c1, c2] = chunksOf(bytes9, 3) as [ChunkMessage, ChunkMessage, ChunkMessage];
  const r = createReceiver(fp9, sha256Hex);
  await r.accept(c2);
  await r.accept(c0);
  const result = await r.accept(c1);
  expect(result).toEqual({ kind: "complete", bytes: bytes9 });
});

it("ignores a duplicate chunk", async () => {
  const [c0] = chunksOf(bytes9, 3) as [ChunkMessage];
  const r = createReceiver(fp9, sha256Hex);
  await r.accept(c0);
  const result = await r.accept(c0);
  expect(result).toEqual({ kind: "partial", receivedBytes: 3 });
});

it("reports a mismatch when the bytes don't match the fingerprint", async () => {
  const chunks = chunksOf(bytes9, 3) as [ChunkMessage, ChunkMessage, ChunkMessage];
  const badFp = "b".repeat(64);
  const r = createReceiver(badFp, sha256Hex);
  await r.accept({ ...chunks[0], fingerprint: badFp });
  await r.accept({ ...chunks[1], fingerprint: badFp });
  const result = await r.accept({ ...chunks[2], fingerprint: badFp });
  expect(result).toEqual({ kind: "mismatch" });
});

it("ignores a corrupted duplicate and completes with the original data", async () => {
  const [c0, c1, c2] = chunksOf(bytes9, 3) as [ChunkMessage, ChunkMessage, ChunkMessage];
  const r = createReceiver(fp9, sha256Hex);
  await r.accept(c0);
  // corrupted duplicate: same index but different data
  await r.accept({ ...c0, data: encodeBase64(new Uint8Array([99, 99, 99])) });
  await r.accept(c1);
  const result = await r.accept(c2);
  // original c0 is kept; hash matches → complete
  expect(result).toEqual({ kind: "complete", bytes: bytes9 });
});
