import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackupFlow } from "../../../src/backup/backup.js";
import {
  createDatabaseReplacer,
  LIVE_DB,
  REPLACED_DB,
  RESTORING_DB,
  recoverInterruptedReplace,
} from "../../../src/backup/replace.js";
import { createActivityStore } from "../../../src/history/activityStore.js";
import { createHarness, type Harness } from "../../support/backupHarness.js";
import { openNodeBackup } from "../../support/nodeSqliteDriver.js";
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
  it("restores when the device key was lost, with a freshly minted key", async () => {
    const lost = Object.assign(new Error("gone"), { name: "KeyLostError" });
    const keys: string[] = [];
    const replace = createDatabaseReplacer(
      target.replacerDeps({
        databaseKeyHex: async () => {
          throw lost;
        },
        mintDatabaseKeyHex: async () => {
          keys.push("minted");
          return "cd".repeat(32);
        },
      }),
    );
    await replace(await openedBackup());
    expect(keys).toEqual(["minted"]);
    expect((await createActivityStore(target.db).list()).map((a) => a.id)).toEqual([activity().id]);
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

  it("discards leftovers when the live file is there", () => {
    writeFileSync(target.files.pathOf(REPLACED_DB), "old");
    writeFileSync(target.files.pathOf(RESTORING_DB), "new");
    recoverInterruptedReplace(target.files);
    expect(target.files.exists(LIVE_DB)).toBe(true);
    expect(target.files.exists(REPLACED_DB)).toBe(false);
    expect(target.files.exists(RESTORING_DB)).toBe(false);
  });
});
