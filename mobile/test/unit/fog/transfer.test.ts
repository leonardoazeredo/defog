import { expect, it } from "vitest";
import { decodeBase64 } from "../../../src/bridge/base64.js";
import { chunkCount, streamCopy } from "../../../src/fog/transfer.js";
import { createMemoryFileStore } from "../../support/memoryFileStore.js";

it("splits a file into base64 chunks that reassemble", async () => {
  const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const fs = createMemoryFileStore({ files: new Map([["test.zip", data]]) });
  const fingerprint = "a".repeat(64);
  const sent: Array<{ index: number; total: number; data: string }> = [];
  await streamCopy({
    fs,
    zipName: "test.zip",
    fingerprint,
    send: (msg) => {
      if (msg.type === "chunk") sent.push({ index: msg.index, total: msg.total, data: msg.data });
    },
    chunkBytes: 4,
    signal: new AbortController().signal,
  });
  expect(sent).toHaveLength(3);
  expect(sent[0]?.total).toBe(3);
  expect(sent.every((c) => c.total === 3)).toBe(true);
  expect(sent.every((c) => c.data.length > 0)).toBe(true);
  const reassembled = new Uint8Array(sent.flatMap((c) => [...decodeBase64(c.data)]));
  expect(reassembled).toEqual(data);
});

it("stops when aborted", async () => {
  const data = new Uint8Array(8);
  const fs = createMemoryFileStore({ files: new Map([["test.zip", data]]) });
  const controller = new AbortController();
  const sent: number[] = [];
  await streamCopy({
    fs,
    zipName: "test.zip",
    fingerprint: "a".repeat(64),
    send: (msg) => {
      if (msg.type === "chunk") {
        sent.push(msg.index);
        controller.abort();
      }
    },
    chunkBytes: 4,
    signal: controller.signal,
  });
  expect(sent).toHaveLength(1);
});

it("counts chunks", () => {
  expect(chunkCount(0, 4)).toBe(1);
  expect(chunkCount(8, 4)).toBe(2);
  expect(chunkCount(9, 4)).toBe(3);
});
