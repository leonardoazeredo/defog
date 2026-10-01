import { decodeBase64 } from "../src/bridge/base64.js";
import type { ChunkMessage } from "../src/bridge/protocol.js";

export type ReceiveResult =
  | { kind: "partial"; receivedBytes: number }
  | { kind: "complete"; bytes: Uint8Array }
  | { kind: "mismatch" };

export function createReceiver(
  fingerprint: string,
  sha256Hex: (bytes: Uint8Array) => Promise<string>,
): { accept(chunk: ChunkMessage): Promise<ReceiveResult> } {
  const chunks = new Map<number, Uint8Array>();
  let total = 0;

  return {
    async accept(chunk: ChunkMessage): Promise<ReceiveResult> {
      total = chunk.total;
      // First arrival wins: if the same index is re-sent (e.g. a corrupted re-delivery),
      // the original is kept. The hash check at assembly time catches any corruption.
      if (!chunks.has(chunk.index)) {
        chunks.set(chunk.index, decodeBase64(chunk.data));
      }
      const receivedBytes = Array.from(chunks.values()).reduce((s, b) => s + b.length, 0);

      if (chunks.size < total) {
        return { kind: "partial", receivedBytes };
      }

      const assembled = new Uint8Array(receivedBytes);
      let offset = 0;
      for (let i = 0; i < total; i++) {
        const part = chunks.get(i)!;
        assembled.set(part, offset);
        offset += part.length;
      }

      const hash = await sha256Hex(assembled);
      if (hash !== fingerprint) return { kind: "mismatch" };
      return { kind: "complete", bytes: assembled };
    },
  };
}
