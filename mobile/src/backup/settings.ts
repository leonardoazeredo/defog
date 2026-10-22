import type { NativeToWeb } from "../bridge/protocol.js";

const KEY_RE = /^f2m_[A-Za-z0-9_]{1,64}$/;
export const MAX_SETTINGS_BYTES = 16_384;

/** The page's saved choices as `{key: value}`; null when the text is anything else, so nothing foreign reaches localStorage. */
export function parseSettings(json: string): Record<string, string> | null {
  if (json.length > MAX_SETTINGS_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!KEY_RE.test(k) || typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

export interface SettingsChannel {
  /** The page's settings as JSON; rejects when it does not answer in time or answers nonsense. */
  request(): Promise<string>;
  /** Resolves once the page has written the settings, so a reload right after sees them. */
  apply(json: string): Promise<void>;
  onSettings(json: string): void;
  onApplied(): void;
}

export function createSettingsChannel(deps: {
  send(msg: NativeToWeb): void;
  timeoutMs: number;
}): SettingsChannel {
  let waitingSettings: ((json: string | Error) => void) | null = null;
  let waitingApplied: ((ok: true | Error) => void) | null = null;
  const failure = () => new Error("the page settings did not arrive");

  return {
    request() {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waitingSettings = null;
          reject(failure());
        }, deps.timeoutMs);
        waitingSettings = (answer) => {
          clearTimeout(timer);
          waitingSettings = null;
          if (typeof answer === "string") resolve(answer);
          else reject(answer);
        };
        deps.send({ v: 1, type: "needSettings" });
      });
    },
    apply(json) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waitingApplied = null;
          reject(failure());
        }, deps.timeoutMs);
        waitingApplied = (answer) => {
          clearTimeout(timer);
          waitingApplied = null;
          if (answer === true) resolve();
          else reject(answer);
        };
        deps.send({ v: 1, type: "applySettings", json });
      });
    },
    onSettings(json) {
      waitingSettings?.(parseSettings(json) === null ? failure() : json);
    },
    onApplied() {
      waitingApplied?.(true);
    },
  };
}
