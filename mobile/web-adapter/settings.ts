import { isSettingsKey, MAX_SETTINGS_BYTES, parseSettings } from "../src/backup/settings.js";

export interface PageSettings {
  /** The page's saved choices (its `f2m_` localStorage keys) as JSON. */
  collect(): string;
  /** Replaces them with `json`; false, with nothing changed, when it is not valid settings. */
  apply(json: string): boolean;
}

const PREFIX = "f2m_";

function ownKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  return keys;
}

export function createPageSettings(storage: Storage): PageSettings {
  return {
    collect() {
      const out: Record<string, string> = {};
      try {
        for (const key of ownKeys(storage)) {
          const value = storage.getItem(key);
          // Entries the receiving side would refuse, or that would push past
          // MAX_SETTINGS_BYTES, are dropped one at a time so the rest still restore.
          if (value === null || !isSettingsKey(key)) continue;
          out[key] = value;
          if (JSON.stringify(out).length > MAX_SETTINGS_BYTES) delete out[key];
        }
      } catch {
        return "{}";
      }
      return JSON.stringify(out);
    },
    apply(json) {
      const settings = parseSettings(json);
      if (settings === null) return false;
      try {
        // New values first, so a write that fails leaves the old settings next to the new ones rather than none.
        for (const [key, value] of Object.entries(settings)) storage.setItem(key, value);
        for (const key of ownKeys(storage)) if (!(key in settings)) storage.removeItem(key);
      } catch {
        return false;
      }
      return true;
    },
  };
}
