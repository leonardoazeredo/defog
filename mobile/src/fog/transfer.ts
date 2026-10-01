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
  const fileSize = await fs.size(zipName);
  const total = chunkCount(fileSize, chunkBytes);
  for (let i = 0; i < total; i++) {
    if (signal.aborted) break;
    const bytes = await fs.readRange(zipName, i * chunkBytes, chunkBytes);
    send({ v: 1, type: "chunk", fingerprint, index: i, total, data: encodeBase64(bytes) });
  }
}
