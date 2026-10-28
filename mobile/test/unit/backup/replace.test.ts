import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackupFlow } from "../../../src/backup/backup.js";
import {
  createDatabaseReplacer,
  discardReplacedCopy,
  LIVE_DB,
  putBackReplacedCopy,
  REPLACED_DB,
  RESTORING_DB,
  type ReplaceDeps,
  recoverInterruptedReplace,
} from "../../../src/backup/replace.js";
import { checkedKeyHex } from "../../../src/db/keyHex.js";
import { createActivityStore } from "../../../src/history/activityStore.js";
import { createHarness, type Harness } from "../../support/backupHarness.js";
import { createNodeSqliteDriver, openNodeBackup } from "../../support/nodeSqliteDriver.js";
import { activity } from "../history/fixtures.js";

let source: Harness;
let target: Harness;
beforeEach(async () => {
  source = await createHarness();
  await source.seed();
  target = await createHarness();
});
afterEach(() => {
  source.cleanup();
  target.cleanup();
});

async function openedBackup() {
  const path = join(source.dir, "b.db");
  await createBackupFlow({
    withDb: (fn) => fn(source.db),
    openBackup: openNodeBackup,
    fogStore: source.fogStore,
    fs: source.fs,
    scratch: source.scratch,
    settings: { request: async () => "{}" },
    askPassphrase: async () => ({ kind: "none" }),
    confirmUnencrypted: async () => true,
    saveAs: async (p, name) => {
      const { copyNodeBackup } = await import("../../support/nodeSqliteDriver.js");
      copyNodeBackup(p, path);
      return { name };
    },
    now: () => 0,
  }).run();
  return openNodeBackup(path, null);
}

describe("database replacer", () => {
  const lost = Object.assign(new Error("gone"), { name: "KeyLostError" });

  function lostKeyDeps(over: Partial<ReplaceDeps> = {}) {
    const kept: string[] = [];
    const deps = target.replacerDeps({
      databaseKeyHex: async () => {
        throw lost;
      },
      keyState: async () => "lost" as const,
      newDatabaseKeyHex: () => checkedKeyHex("cd".repeat(32)),
      replaceLostDatabaseKey: async (keyHex) => {
        kept.push(keyHex);
      },
      ...over,
    });
    return { deps, kept };
  }

  it("restores when the device key was lost, keeping the new key it built the file with", async () => {
    const seen: string[] = [];
    const { deps, kept } = lostKeyDeps();
    const backup = await openedBackup();
    const real = backup.exportTo;
    backup.exportTo = async (path, key) => {
      seen.push(String(key));
      return real(path, key);
    };
    await createDatabaseReplacer(deps)(backup);
    expect(seen).toEqual([`x'${"cd".repeat(32)}'`]);
    expect(kept).toEqual(["cd".repeat(32)]);
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([activity().id]);
  });

  it("restores over a key that is present but fails for good, keeping the new key after the swap", async () => {
    const at: Array<{ live: boolean; replaced: boolean; restoring: boolean }> = [];
    const { deps, kept } = lostKeyDeps({
      keyState: async () => "unreadable" as const,
      replaceLostDatabaseKey: async (keyHex) => {
        at.push({
          live: target.files.exists(LIVE_DB),
          replaced: target.files.exists(REPLACED_DB),
          restoring: target.files.exists(RESTORING_DB),
        });
        kept.push(keyHex);
      },
    });
    await createDatabaseReplacer(deps)(await openedBackup());
    expect(kept).toEqual(["cd".repeat(32)]);
    expect(at).toEqual([{ live: true, replaced: true, restoring: false }]);
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([activity().id]);
  });

  it("keeps the new key only once the new file is in place", async () => {
    const at: Array<{ live: boolean; replaced: boolean; restoring: boolean }> = [];
    const { deps } = lostKeyDeps({
      replaceLostDatabaseKey: async () => {
        at.push({
          live: target.files.exists(LIVE_DB),
          replaced: target.files.exists(REPLACED_DB),
          restoring: target.files.exists(RESTORING_DB),
        });
      },
    });
    await createDatabaseReplacer(deps)(await openedBackup());
    expect(at).toEqual([{ live: true, replaced: true, restoring: false }]);
  });

  it("leaves the old key and file untouched when a lost-key restore cannot build the new file", async () => {
    await createActivityStore(target.db).add(
      activity({ id: "33333333-3333-4333-8333-333333333333" }),
    );
    const { deps, kept } = lostKeyDeps();
    const backup = await openedBackup();
    backup.exportTo = async () => {
      throw new Error("no space");
    };
    await expect(createDatabaseReplacer(deps)(backup)).rejects.toThrow("no space");
    expect(kept).toEqual([]);
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(target.files.exists(RESTORING_DB)).toBe(false);
  });

  it("puts the old file back when the new key cannot be kept", async () => {
    await createActivityStore(target.db).add(
      activity({ id: "33333333-3333-4333-8333-333333333333" }),
    );
    const { deps } = lostKeyDeps({
      replaceLostDatabaseKey: async () => {
        throw new Error("keystore refused");
      },
    });
    await expect(createDatabaseReplacer(deps)(await openedBackup())).rejects.toThrow(
      "keystore refused",
    );
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(target.files.exists(REPLACED_DB)).toBe(false);
    expect(target.files.exists(RESTORING_DB)).toBe(false);
  });

  it("leaves the old file untouched when the key cannot be read but is not one a restore may replace", async () => {
    await createActivityStore(target.db).add(
      activity({ id: "33333333-3333-4333-8333-333333333333" }),
    );
    const { deps, kept } = lostKeyDeps({ keyState: async () => "existing" as const });
    const backup = await openedBackup();
    let exported = false;
    backup.exportTo = async () => {
      exported = true;
    };
    await expect(createDatabaseReplacer(deps)(backup)).rejects.toThrow(
      expect.objectContaining({ name: "KeyLostError" }),
    );
    expect(exported).toBe(false);
    expect(kept).toEqual([]);
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("replaces no key that reads as fresh", async () => {
    const { deps, kept } = lostKeyDeps({ keyState: async () => "fresh" as const });
    const backup = await openedBackup();
    let exported = false;
    backup.exportTo = async () => {
      exported = true;
    };
    await expect(createDatabaseReplacer(deps)(backup)).rejects.toThrow(
      expect.objectContaining({ name: "KeyLostError" }),
    );
    expect(exported).toBe(false);
    expect(kept).toEqual([]);
  });

  it("rethrows a key the native side could not reach, without asking its state or minting one", async () => {
    const unavailable = Object.assign(new Error("cannot reach the database key"), {
      name: "KeyUnavailableError",
    });
    let askedState = false;
    let minted = false;
    const { deps, kept } = lostKeyDeps({
      databaseKeyHex: async () => {
        throw unavailable;
      },
      keyState: async () => {
        askedState = true;
        return "lost" as const;
      },
      newDatabaseKeyHex: () => {
        minted = true;
        return checkedKeyHex("cd".repeat(32));
      },
    });
    const backup = await openedBackup();
    let exported = false;
    backup.exportTo = async () => {
      exported = true;
    };
    await expect(createDatabaseReplacer(deps)(backup)).rejects.toBe(unavailable);
    expect(askedState).toBe(false);
    expect(minted).toBe(false);
    expect(exported).toBe(false);
    expect(kept).toEqual([]);
    expect(target.files.exists(LIVE_DB)).toBe(true);
  });

  it("keeps the new key before reopening, which reads it", async () => {
    const order: string[] = [];
    const { deps } = lostKeyDeps();
    const reopen = deps.reopen;
    await createDatabaseReplacer({
      ...deps,
      replaceLostDatabaseKey: async () => {
        order.push("keep");
      },
      reopen: async () => {
        order.push("reopen");
        await reopen();
      },
    })(await openedBackup());
    expect(order).toEqual(["keep", "reopen"]);
  });

  it("keeps the new file live when it does not reopen after its key was kept", async () => {
    await createActivityStore(target.db).add(
      activity({ id: "33333333-3333-4333-8333-333333333333" }),
    );
    let keptKey = false;
    let failed = false;
    const { deps } = lostKeyDeps();
    const reopen = deps.reopen;
    await expect(
      createDatabaseReplacer({
        ...deps,
        replaceLostDatabaseKey: async () => {
          keptKey = true;
        },
        reopen: async () => {
          if (keptKey && !failed) {
            failed = true;
            throw new Error("busy");
          }
          await reopen();
        },
      })(await openedBackup()),
    ).rejects.toThrow("busy");
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([activity().id]);
    expect(target.files.exists(REPLACED_DB)).toBe(false);
    expect(target.files.exists(RESTORING_DB)).toBe(false);
  });

  it("reports the lost key when the key state cannot be read", async () => {
    const { deps, kept } = lostKeyDeps({
      keyState: async () => {
        throw new Error("keystore busy");
      },
    });
    await expect(createDatabaseReplacer(deps)(await openedBackup())).rejects.toThrow(
      expect.objectContaining({ name: "KeyLostError" }),
    );
    expect(kept).toEqual([]);
  });

  it("keeps no new key when the device key still works", async () => {
    const kept: string[] = [];
    await createDatabaseReplacer(
      target.replacerDeps({
        replaceLostDatabaseKey: async (keyHex) => {
          kept.push(keyHex);
        },
      }),
    )(await openedBackup());
    expect(kept).toEqual([]);
  });

  it("exports with the raw device key", async () => {
    const seen: string[] = [];
    const backup = await openedBackup();
    const real = backup.exportTo;
    backup.exportTo = async (path, key) => {
      seen.push(String(key));
      return real(path, key);
    };
    await createDatabaseReplacer(target.replacerDeps())(backup);
    expect(seen).toEqual([`x'${"ab".repeat(32)}'`]);
  });

  it("leaves the old database in place and usable when the new one cannot be built", async () => {
    await createActivityStore(target.db).add(
      activity({ id: "33333333-3333-4333-8333-333333333333" }),
    );
    const backup = await openedBackup();
    backup.exportTo = async () => {
      throw new Error("no space");
    };
    await expect(createDatabaseReplacer(target.replacerDeps())(backup)).rejects.toThrow("no space");
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(target.files.exists(RESTORING_DB)).toBe(false);
  });

  it("puts the old file back when the swapped one does not open", async () => {
    await createActivityStore(target.db).add(
      activity({ id: "33333333-3333-4333-8333-333333333333" }),
    );
    let opens = 0;
    const deps = target.replacerDeps();
    const replace = createDatabaseReplacer({
      ...deps,
      reopen: async () => {
        opens++;
        if (opens === 1) throw new Error("does not open");
        await deps.reopen();
      },
    });
    await expect(replace(await openedBackup())).rejects.toThrow("does not open");
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(target.files.exists(REPLACED_DB)).toBe(false);
  });

  it("puts the old file back when moving the new one into place fails", async () => {
    await createActivityStore(target.db).add(
      activity({ id: "33333333-3333-4333-8333-333333333333" }),
    );
    const deps = target.replacerDeps();
    const files = {
      ...target.files,
      move(from: string, to: string) {
        if (from === RESTORING_DB && to === LIVE_DB) throw new Error("rename failed");
        target.files.move(from, to);
      },
    };
    await expect(createDatabaseReplacer({ ...deps, files })(await openedBackup())).rejects.toThrow(
      "rename failed",
    );
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(target.files.exists(REPLACED_DB)).toBe(false);
    expect(target.files.exists(RESTORING_DB)).toBe(false);
  });

  it("keeps the live file when the swap fails before it was set aside", async () => {
    await createActivityStore(target.db).add(
      activity({ id: "33333333-3333-4333-8333-333333333333" }),
    );
    const deps = target.replacerDeps();
    const files = {
      ...target.files,
      move(from: string, to: string) {
        if (from === LIVE_DB) throw new Error("move failed");
        target.files.move(from, to);
      },
    };
    await expect(createDatabaseReplacer({ ...deps, files })(await openedBackup())).rejects.toThrow(
      "move failed",
    );
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("refuses a restored database that does not match the backup", async () => {
    await createActivityStore(target.db).add(
      activity({ id: "33333333-3333-4333-8333-333333333333" }),
    );
    const backup = await openedBackup();
    const real = backup.exportTo;
    backup.exportTo = async (path, key) => {
      await real(path, key);
      const damaged = createNodeSqliteDriver(path);
      await damaged.run("DELETE FROM activities");
      await damaged.close();
    };
    await expect(createDatabaseReplacer(target.replacerDeps())(backup)).rejects.toThrow(
      "does not match",
    );
    expect(target.files.exists(RESTORING_DB)).toBe(false);
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("restores the old file even when reopening fails every time", async () => {
    await createActivityStore(target.db).add(
      activity({ id: "33333333-3333-4333-8333-333333333333" }),
    );
    const deps = target.replacerDeps();
    let broken = true;
    const replace = createDatabaseReplacer({
      ...deps,
      reopen: async () => {
        if (broken) throw new Error("does not open");
        await deps.reopen();
      },
    });
    await expect(replace(await openedBackup())).rejects.toThrow("does not open");
    expect(target.files.exists(LIVE_DB)).toBe(true);
    expect(target.files.exists(REPLACED_DB)).toBe(false);
    broken = false;
    await deps.reopen();
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("waits for a running store call before it closes the database", async () => {
    const order: string[] = [];
    let release!: () => void;
    const busy = target.gate.shared(
      () =>
        new Promise<void>((r) => {
          release = () => {
            order.push("call done");
            r();
          };
        }),
    );
    const deps = target.replacerDeps();
    const replace = createDatabaseReplacer({
      ...deps,
      closeLive: async () => {
        order.push("closed");
        await deps.closeLive();
      },
    });
    const done = replace(await openedBackup());
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([busy, done]);
    expect(order).toEqual(["call done", "closed"]);
  });
});

describe("interrupted swap recovery", () => {
  it("moves the replaced file back when the live file is gone", () => {
    writeFileSync(target.files.pathOf(REPLACED_DB), "old");
    target.files.remove(LIVE_DB);
    recoverInterruptedReplace(target.files);
    expect(target.files.exists(LIVE_DB)).toBe(true);
    expect(target.files.exists(REPLACED_DB)).toBe(false);
  });

  it("keeps the replaced copy while the live file is unproven, and drops a half-built file", () => {
    writeFileSync(target.files.pathOf(REPLACED_DB), "old");
    writeFileSync(target.files.pathOf(RESTORING_DB), "new");
    recoverInterruptedReplace(target.files);
    expect(target.files.exists(LIVE_DB)).toBe(true);
    expect(target.files.exists(REPLACED_DB)).toBe(true);
    expect(target.files.exists(RESTORING_DB)).toBe(false);
  });

  it("puts the replaced copy back over a live file that did not open", () => {
    writeFileSync(target.files.pathOf(REPLACED_DB), "old");
    putBackReplacedCopy(target.files);
    expect(readFileSync(target.files.pathOf(LIVE_DB), "utf8")).toBe("old");
    expect(target.files.exists(REPLACED_DB)).toBe(false);
  });

  it("leaves the live file alone when nothing was set aside", () => {
    putBackReplacedCopy(target.files);
    expect(target.files.exists(LIVE_DB)).toBe(true);
  });

  it("drops the replaced copy once the live file has proven itself", () => {
    writeFileSync(target.files.pathOf(REPLACED_DB), "old");
    discardReplacedCopy(target.files);
    expect(target.files.exists(REPLACED_DB)).toBe(false);
    expect(target.files.exists(LIVE_DB)).toBe(true);
  });
});
