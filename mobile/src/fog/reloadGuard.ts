import type { FileStore } from "./fileStore.js";

export interface ReloadGuard {
  beforeReload(fingerprint: string): Promise<"reload" | "suspended">;
  onLoaded(): Promise<void>;
  reset(): Promise<void>;
}

// Kept as-is so an updated app reads the marker the previous build left.
const RECORD_FILE = "restoring.json";

interface GuardRecord {
  fingerprint: string;
  attempts: number;
}

function parseRecord(text: string): GuardRecord | null {
  try {
    const obj = JSON.parse(text) as unknown;
    if (
      typeof obj === "object" &&
      obj !== null &&
      "fingerprint" in obj &&
      "attempts" in obj &&
      typeof (obj as Record<string, unknown>).fingerprint === "string" &&
      typeof (obj as Record<string, unknown>).attempts === "number"
    ) {
      return obj as GuardRecord;
    }
    return null;
  } catch {
    return null;
  }
}

export function createReloadGuard(fs: FileStore, maxAttempts = 2): ReloadGuard {
  async function readRecord(): Promise<GuardRecord | null> {
    const text = await fs.readText(RECORD_FILE);
    return text != null ? parseRecord(text) : null;
  }

  async function writeRecord(record: GuardRecord): Promise<void> {
    await fs.remove(RECORD_FILE);
    await fs.createText(RECORD_FILE, JSON.stringify(record));
  }

  return {
    async beforeReload(fingerprint) {
      const rec = await readRecord();
      const attempts = rec?.fingerprint === fingerprint ? rec.attempts : 0;
      if (attempts >= maxAttempts) return "suspended";
      await writeRecord({ fingerprint, attempts: attempts + 1 });
      return "reload";
    },

    async onLoaded() {
      await fs.remove(RECORD_FILE);
    },

    async reset() {
      await fs.remove(RECORD_FILE);
    },
  };
}
