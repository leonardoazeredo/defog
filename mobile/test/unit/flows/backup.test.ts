import { describe, expect, it, vi } from "vitest";
import { BackupError } from "../../../src/backup/types.js";
import { COPY } from "../../../src/copy.js";
import { createBackupFlows } from "../../../src/flows/backup.js";

function setup(over: { backup?: () => Promise<never>; restore?: () => Promise<never> } = {}) {
  const notify = vi.fn();
  const backupRun = vi.fn(async () => ({ status: "saved" as const, name: "b.db" }));
  const restoreRun = vi.fn(async () => "restored" as const);
  const flows = createBackupFlows({
    backup: { run: (over.backup ?? backupRun) as typeof backupRun },
    restore: { run: (over.restore ?? restoreRun) as typeof restoreRun },
    notify,
  });
  return { flows, notify, backupRun, restoreRun };
}

describe("backup flows", () => {
  it("names the document the backup got", async () => {
    const { flows, notify } = setup();
    await flows.backup();
    expect(notify).toHaveBeenCalledWith(COPY.backupSaved("b.db"));
  });

  it("says nothing when the backup is cancelled", async () => {
    const notify = vi.fn();
    const flows = createBackupFlows({
      backup: { run: async () => ({ status: "cancelled" }) },
      restore: { run: async () => "cancelled" },
      notify,
    });
    await flows.backup();
    expect(await flows.restore()).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    ["noSpace", COPY.backupNoSpace],
    ["noSettings", COPY.backupNoSettings],
  ] as const)("explains a %s failure", async (code, text) => {
    const { flows, notify } = setup({
      backup: async () => {
        throw new BackupError(code);
      },
    });
    await flows.backup();
    expect(notify).toHaveBeenCalledWith(text);
  });

  it("does not reject when the backup fails, and logs only the error name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { flows, notify } = setup({
      backup: async () => {
        throw new Error("lat 48.12345 at /data/user/0/x");
      },
    });
    await expect(flows.backup()).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith(COPY.backupFailed);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("48.12345");
    warn.mockRestore();
  });

  it.each([
    ["restored", true, COPY.restoreDone],
    ["wrongPassphrase", false, COPY.restoreWrongPassphrase],
    ["notABackup", false, COPY.restoreNotABackup],
  ] as const)("restore %s reports %s", async (result, reload, text) => {
    const notify = vi.fn();
    const flows = createBackupFlows({
      backup: { run: async () => ({ status: "cancelled" }) },
      restore: { run: async () => result },
      notify,
    });
    expect(await flows.restore()).toBe(reload);
    expect(notify).toHaveBeenCalledWith(text);
  });

  it("does not reject when the restore throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { flows, notify } = setup({
      restore: async () => {
        throw new Error("x");
      },
    });
    expect(await flows.restore()).toBe(false);
    expect(notify).toHaveBeenCalledWith(COPY.restoreFailed);
  });

  it("ignores a second request while one is running", async () => {
    const notify = vi.fn();
    let finish!: () => void;
    const flows = createBackupFlows({
      backup: {
        run: () =>
          new Promise((resolve) => {
            finish = () => resolve({ status: "cancelled" });
          }),
      },
      restore: { run: async () => "restored" },
      notify,
    });
    const first = flows.backup();
    expect(await flows.restore()).toBe(false);
    expect(notify).toHaveBeenCalledWith(COPY.backupRunning);
    finish();
    await first;
    expect(await flows.restore()).toBe(true);
  });
});
