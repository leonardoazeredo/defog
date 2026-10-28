import type { BackupResult } from "../backup/backup.js";
import type { RestoreResult } from "../backup/restore.js";
import { BackupError } from "../backup/types.js";
import { COPY } from "../copy.js";
import { warnClass } from "./warn.js";

export interface BackupFlowsDeps {
  backup: { run(): Promise<BackupResult> };
  restore: { run(): Promise<RestoreResult> };
  notify(text: string): void;
}

export interface BackupFlows {
  backup(): Promise<void>;
  /** True when the phone's data was replaced, so the page must reload. */
  restore(): Promise<boolean>;
}

// A flow must not reject, and its failures are the user's to hear about, in words that carry no
// path or position: only the error's name is logged.
export function createBackupFlows(deps: BackupFlowsDeps): BackupFlows {
  let running = false;

  async function exclusive<R>(fallback: R, fn: () => Promise<R>): Promise<R> {
    if (running) {
      deps.notify(COPY.backupRunning);
      return fallback;
    }
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  }

  return {
    backup: () =>
      exclusive(undefined, async () => {
        try {
          const result = await deps.backup.run();
          if (result.status === "saved") deps.notify(COPY.backupSaved(result.name));
        } catch (e) {
          if (e instanceof BackupError && e.code === "noSpace") deps.notify(COPY.backupNoSpace);
          else if (e instanceof BackupError && e.code === "noSettings") {
            deps.notify(COPY.backupNoSettings);
          } else {
            warnClass("backup", "failed", e);
            deps.notify(COPY.backupFailed);
          }
        }
      }),
    restore: () =>
      exclusive(false, async () => {
        try {
          const result = await deps.restore.run();
          switch (result) {
            case "restored":
              deps.notify(COPY.restoreDone);
              return true;
            case "fogNotReplaced":
              deps.notify(COPY.restoreFogNotReplaced);
              return true;
            case "wrongPassphrase":
              deps.notify(COPY.restoreWrongPassphrase);
              return false;
            case "notABackup":
              deps.notify(COPY.restoreNotABackup);
              return false;
            case "cancelled":
              return false;
          }
        } catch (e) {
          warnClass("restore", "failed", e);
          deps.notify(COPY.restoreFailed);
          return false;
        }
      }),
  };
}
