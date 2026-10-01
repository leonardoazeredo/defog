import type { FileStore } from "./fileStore.js";

export interface RestoreGuard {
  beforeRestore(fingerprint: string): Promise<"restore" | "suspended">;
  onLoaded(): Promise<void>;
  reset(): Promise<void>;
}

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

export function createRestoreGuard(fs: FileStore, maxAttempts = 2): RestoreGuard {
  async function readRecord(): Promise<GuardRecord | null> {
    const text = await fs.readText(RECORD_FILE);
    return text != null ? parseRecord(text) : null;
  }

  async function writeRecord(record: GuardRecord): Promise<void> {
    await fs.remove(RECORD_FILE);
    await fs.createText(RECORD_FILE, JSON.stringify(record));
  }

  return {
    async beforeRestore(fingerprint) {
      const rec = await readRecord();
      const attempts = rec?.fingerprint === fingerprint ? rec.attempts : 0;
      if (attempts >= maxAttempts) return "suspended";
      await writeRecord({ fingerprint, attempts: attempts + 1 });
      return "restore";
    },

    async onLoaded() {
      await fs.remove(RECORD_FILE);
    },

    async reset() {
      await fs.remove(RECORD_FILE);
    },
  };
}
