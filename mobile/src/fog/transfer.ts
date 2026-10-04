import { encodeBase64 } from "../bridge/base64.js";
import type { NativeToWeb } from "../bridge/protocol.js";
import type { FileStore } from "./fileStore.js";

export const CHUNK_BYTES = 1_048_576;

export function chunkCount(size: number, chunkBytes: number): number {
  return Math.max(1, Math.ceil(size / chunkBytes));
}

export async function streamCopy(args: {
  fs: FileStore;
  zipName: string;
  fingerprint: string;
  send(msg: NativeToWeb): void;
  chunkBytes: number;
  signal: AbortSignal;
}): Promise<void> {
  const { fs, zipName, fingerprint, send, chunkBytes, signal } = args;
  const allBytes = await fs.readBytes(zipName);
  const fileSize = allBytes.length;
  const total = chunkCount(fileSize, chunkBytes);
  for (let i = 0; i < total; i++) {
    if (signal.aborted) break;
    const start = i * chunkBytes;
    const bytes = allBytes.subarray(start, Math.min(start + chunkBytes, fileSize));
    send({ v: 1, type: "chunk", fingerprint, index: i, total, data: encodeBase64(bytes) });
  }
}
