import { z } from "zod";
import type { FileStore } from "./fileStore.js";
import { FileExistsError } from "./fileStore.js";

export interface SourceFile {
  uri: string;
  name: string;
}

export interface CopyMeta {
  name: string;
  sha256: string;
  size: number;
  savedAt: string;
  source: "picker" | "share";
}

export interface FogStore {
  recover(): Promise<{ discardedPending: boolean }>;
  current(): Promise<CopyMeta | null>;
  pending(): Promise<CopyMeta | null>;
  beginImport(file: SourceFile, source: CopyMeta["source"]): Promise<CopyMeta>;
  promotePending(): Promise<void>;
  discardPending(): Promise<void>;
  clear(): Promise<void>;
}

export function zipName(meta: CopyMeta): string {
  return `${meta.sha256}.zip`;
}

const copyMetaSchema = z.object({
  name: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(0),
  savedAt: z.string(),
  source: z.enum(["picker", "share"]),
});

const POINTER_RE = /^current-(\d{6})\.json$/;

function pointerNum(name: string): number | null {
  const m = POINTER_RE.exec(name);
  return m ? Number(m[1]) : null;
}

function pointerName(n: number): string {
  return `current-${String(n).padStart(6, "0")}.json`;
}

function parseMeta(text: string): CopyMeta | null {
  try {
    const result = copyMetaSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function createFogStore(
  fs: FileStore,
  deps: { sha256Hex(bytes: Uint8Array): Promise<string>; now(): number },
): FogStore {
  async function readMeta(name: string): Promise<CopyMeta | null> {
    const text = await fs.readText(name);
    return text != null ? parseMeta(text) : null;
  }

  async function currentPointer(): Promise<{ name: string; num: number } | null> {
    const names = await fs.list();
    let best: { name: string; num: number } | null = null;
    for (const name of names) {
      const n = pointerNum(name);
      if (n != null && (best == null || n > best.num)) best = { name, num: n };
    }
    return best;
  }

  async function gc(): Promise<void> {
    const pointer = await currentPointer();
    const currentMeta = pointer ? await readMeta(pointer.name) : null;
    const pendingMeta = await readMeta("pending.json");
    const kept = new Set<string>();
    if (currentMeta) kept.add(zipName(currentMeta));
    if (pendingMeta) kept.add(zipName(pendingMeta));
    for (const name of await fs.list()) {
      if (name.endsWith(".zip") && !kept.has(name)) await fs.remove(name);
    }
  }

  return {
    async current() {
      const pointer = await currentPointer();
      if (!pointer) return null;
      return readMeta(pointer.name);
    },

    async pending() {
      return readMeta("pending.json");
    },

    async beginImport(file, source) {
      await fs.remove("incoming.tmp");
      await fs.importFrom(file.uri, "incoming.tmp");
      const bytes = await fs.readBytes("incoming.tmp");
      const sha256 = await deps.sha256Hex(bytes);
      const zName = `${sha256}.zip`;
      const meta: CopyMeta = {
        name: file.name,
        sha256,
        size: bytes.length,
        savedAt: new Date(deps.now()).toISOString(),
        source,
      };
      if (await fs.exists(zName)) {
        await fs.remove("incoming.tmp");
      } else {
        await fs.rename("incoming.tmp", zName);
      }
      await fs.remove("pending.json");
      await fs.createText("pending.json", JSON.stringify(meta));
      return meta;
    },

    async promotePending() {
      const meta = await readMeta("pending.json");
      if (!meta) throw new Error("no pending import");
      const pointer = await currentPointer();
      const nextNum = (pointer?.num ?? 0) + 1;
      await fs.createText(pointerName(nextNum), JSON.stringify(meta));
      if (pointer) await fs.remove(pointer.name);
      await fs.remove("pending.json");
      await gc();
    },

    async discardPending() {
      await fs.remove("pending.json");
      await gc();
    },

    async clear() {
      await fs.remove("pending.json");
      const names = await fs.list();
      for (const name of names) {
        if (pointerNum(name) != null) await fs.remove(name);
      }
      await gc();
    },

    async recover() {
      for (const name of await fs.list()) {
        if (name.endsWith(".tmp")) await fs.remove(name);
      }

      const pointers = (await fs.list()).filter((n) => pointerNum(n) != null);
      pointers.sort((a, b) => (pointerNum(b) ?? 0) - (pointerNum(a) ?? 0));

      let kept: string | null = null;
      for (const ptr of pointers) {
        if (kept == null) {
          const meta = await readMeta(ptr);
          if (meta && (await fs.exists(zipName(meta)))) {
            kept = ptr;
            continue;
          }
        }
        await fs.remove(ptr);
      }

      const hasPending = await fs.exists("pending.json");
      await fs.remove("pending.json");

      await gc();

      return { discardedPending: hasPending };
    },
  };
}
