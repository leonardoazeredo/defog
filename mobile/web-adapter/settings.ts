import { MAX_SETTINGS_BYTES, parseSettings } from "../src/backup/settings.js";

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
          if (value !== null) out[key] = value;
        }
      } catch {
        return "{}";
      }
      // Only what the receiving side would accept: a backup that cannot be restored is worse than one without settings.
      const json = JSON.stringify(out);
      return json.length <= MAX_SETTINGS_BYTES && parseSettings(json) !== null ? json : "{}";
    },
    apply(json) {
      const settings = parseSettings(json);
      if (settings === null) return false;
      try {
        for (const key of ownKeys(storage)) storage.removeItem(key);
        for (const [key, value] of Object.entries(settings)) storage.setItem(key, value);
      } catch {
        return false;
      }
      return true;
    },
  };
}
