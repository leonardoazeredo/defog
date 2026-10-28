import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackupFlow } from "../../../src/backup/backup.js";
import { createDatabaseReplacer } from "../../../src/backup/replace.js";
import { createRestoreFlow, type RestoreDeps } from "../../../src/backup/restore.js";
import type { PassphraseAnswer } from "../../../src/backup/types.js";
import { SCHEMA_VERSION } from "../../../src/db/schema.js";
import { createActivityStore } from "../../../src/history/activityStore.js";
import { createRouteStore } from "../../../src/history/routeStore.js";
import { createHarness, type Harness, ZIP_BYTES } from "../../support/backupHarness.js";
import {
  copyNodeBackup,
  createNodeSqliteDriver,
  openNodeBackup,
} from "../../support/nodeSqliteDriver.js";
import { createV1Database } from "../../support/schemaV1.js";
import { activity, route } from "../history/fixtures.js";

const SETTINGS = '{"f2m_units":"imperial"}';
const PASS = "correct horse";
const NOT_PLAIN = "00".repeat(16);
const PLAIN = "53514c69746520666f726d6174203300";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

// Source phone: seeded and backed up. Target phone: a different history, restoring that backup.
let source: Harness;
let target: Harness;
let backupFile: string;

async function makeBackup(answer: PassphraseAnswer, settings = SETTINGS): Promise<string> {
  let saved = "";
  await createBackupFlow({
    withDb: (fn) => fn(source.db),
    openBackup: openNodeBackup,
    fogStore: source.fogStore,
    fs: source.fs,
    scratch: source.scratch,
    settings: { request: async () => settings },
    askPassphrase: async () => answer,
    confirmUnencrypted: async () => true,
    saveAs: async (path, name) => {
      saved = join(source.dir, name);
      copyNodeBackup(path, saved);
      return { name };
    },
    now: () => 0,
  }).run();
  return saved;
}

beforeEach(async () => {
  source = await createHarness();
  await source.seed();
  target = await createHarness();
  await createActivityStore(target.db).add(activity({ id: OTHER_ID }));
  backupFile = await makeBackup({ kind: "passphrase", passphrase: PASS });
});
afterEach(() => {
  source.cleanup();
  target.cleanup();
});

function restore(
  over: Partial<RestoreDeps> = {},
  answer: PassphraseAnswer | null = { kind: "passphrase", passphrase: PASS },
) {
  const confirm = vi.fn(async () => true);
  const askPassphrase = vi.fn(async () => answer);
  const apply = vi.fn(async (_json: string) => {});
  const deps: RestoreDeps = {
    pickFile: async () => ({ uri: "content://downloads/b.db", name: "b.db" }),
    copyFromUri: async (_uri, dest) => {
      copyNodeBackup(backupFile, dest);
      return { size: 8192, head: NOT_PLAIN };
    },
    scratch: target.scratch,
    openBackup: openNodeBackup,
    replaceDatabase: createDatabaseReplacer(target.replacerDeps()),
    fogStore: target.fogStore,
    confirm,
    askPassphrase,
    settings: { apply },
    ...over,
  };
  return { run: () => createRestoreFlow(deps).run(), confirm, askPassphrase, apply };
}

const ids = async (h: Harness) => (await createActivityStore(h.db).list()).map((a) => a.id).sort();

describe("restore flow", () => {
  it("replaces the history, the import and the settings", async () => {
    const r = restore();
    expect(await r.run()).toBe("restored");

    expect(await ids(target)).toEqual([activity().id]);
    expect((await createRouteStore(target.db).list()).map((x) => x.id)).toEqual([route().id]);
    expect(await target.db.all("SELECT * FROM blobs")).toEqual([]);
    const meta = await target.fogStore.current();
    expect(meta?.name).toBe("Sync.zip");
    expect(await target.fs.readBytes(`${meta?.sha256}.zip`)).toEqual(ZIP_BYTES);
    expect(r.apply).toHaveBeenCalledWith(SETTINGS);
    expect(target.scratch.left()).toEqual([]);
  });

  it("asks for confirmation only after the backup has opened", async () => {
    const r = restore();
    await r.run();
    expect(r.askPassphrase.mock.invocationCallOrder[0]).toBeLessThan(
      r.confirm.mock.invocationCallOrder[0] as number,
    );
  });

  it("refuses a wrong passphrase and changes nothing", async () => {
    const r = restore({}, { kind: "passphrase", passphrase: "wrong one" });
    expect(await r.run()).toBe("wrongPassphrase");
    expect(r.confirm).not.toHaveBeenCalled();
    expect(await ids(target)).toEqual([OTHER_ID]);
    expect(await target.fogStore.current()).toBeNull();
    expect(r.apply).not.toHaveBeenCalled();
    expect(target.scratch.left()).toEqual([]);
  });

  it("calls a small text file not a backup, without asking for a passphrase", async () => {
    const r = restore({
      copyFromUri: async (_u, dest) => {
        writeFileSync(dest, "hello");
        return { size: 5, head: "68656c6c6f".padEnd(32, "0") };
      },
    });
    expect(await r.run()).toBe("notABackup");
    expect(r.askPassphrase).not.toHaveBeenCalled();
    expect(target.scratch.left()).toEqual([]);
  });

  it("calls a SQLite file without this app's tables not a backup", async () => {
    const r = restore({
      copyFromUri: async (_u, dest) => {
        const other = new DatabaseSync(dest);
        other.exec("CREATE TABLE notes (x TEXT)");
        other.close();
        return { size: 8192, head: PLAIN };
      },
    });
    expect(await r.run()).toBe("notABackup");
    expect(r.confirm).not.toHaveBeenCalled();
  });

  it("restores a backup from schema 1, migrating its GPX text on open", async () => {
    const gpx = '<gpx><trk><trkseg><trkpt lat="48.1" lon="11.5"/></trkseg></trk></gpx>';
    const r = restore({
      copyFromUri: async (_u, dest) => {
        const old = createNodeSqliteDriver(dest);
        await createV1Database(old, [{ id: activity().id, gpx }]);
        await old.run("INSERT INTO blobs (kind, name, bytes) VALUES ('import', 'Sync.zip', ?)", [
          ZIP_BYTES,
        ]);
        await old.close();
        return { size: 8192, head: PLAIN };
      },
    });
    expect(await r.run()).toBe("restored");
    const [v] = await target.db.all<{ user_version: number }>("PRAGMA user_version");
    expect(v?.user_version).toBe(SCHEMA_VERSION);
    expect(await ids(target)).toEqual([activity().id]);
    expect(await createActivityStore(target.db).gpx(activity().id)).toBe(gpx);
    expect((await target.fogStore.current())?.name).toBe("Sync.zip");
  });

  it("calls a backup from a newer schema not a backup", async () => {
    const r = restore({
      copyFromUri: async (_u, dest) => {
        const other = new DatabaseSync(dest);
        other.exec(
          "CREATE TABLE activities (x); CREATE TABLE routes (x); CREATE TABLE blobs (x); PRAGMA user_version = 99",
        );
        other.close();
        return { size: 8192, head: PLAIN };
      },
    });
    expect(await r.run()).toBe("notABackup");
  });

  it("blames the file, not a passphrase, when a plain SQLite file will not open", async () => {
    const r = restore({
      copyFromUri: async (_u, dest) => {
        writeFileSync(dest, "SQLite format 3\0 but cut short");
        return { size: 8192, head: PLAIN };
      },
    });
    expect(await r.run()).toBe("notABackup");
    expect(r.askPassphrase).not.toHaveBeenCalled();
  });

  it("blames the passphrase when an encrypted-looking file is opened with none", async () => {
    const r = restore({}, { kind: "none" });
    expect(await r.run()).toBe("wrongPassphrase");
  });

  it("changes nothing when the confirmation is declined", async () => {
    expect(await restore({ confirm: async () => false }).run()).toBe("cancelled");
    expect(await ids(target)).toEqual([OTHER_ID]);
    expect(await target.fogStore.current()).toBeNull();
    expect(target.scratch.left()).toEqual([]);
  });

  it("does nothing when the picker or the passphrase dialog is cancelled", async () => {
    expect(await restore({ pickFile: async () => null }).run()).toBe("cancelled");
    expect(await restore({}, null).run()).toBe("cancelled");
    expect(await ids(target)).toEqual([OTHER_ID]);
    expect(target.scratch.left()).toEqual([]);
  });

  it("restores an unencrypted backup without asking for a passphrase", async () => {
    backupFile = await makeBackup({ kind: "none" });
    const r = restore({
      copyFromUri: async (_u, dest) => {
        copyNodeBackup(backupFile, dest);
        return { size: 8192, head: PLAIN };
      },
    });
    expect(await r.run()).toBe("restored");
    expect(r.askPassphrase).not.toHaveBeenCalled();
    expect(await ids(target)).toEqual([activity().id]);
  });

  it("clears the saved import when the backup holds none", async () => {
    await source.fogStore.clear();
    backupFile = await makeBackup({ kind: "passphrase", passphrase: PASS });
    await target.fogStore.beginImport(
      { uri: "file:///picked/Sync.zip", name: "old.zip" },
      "picker",
    );
    await target.fogStore.promotePending();
    expect(await restore().run()).toBe("restored");
    expect(await target.fogStore.current()).toBeNull();
  });

  it("keeps the old import when swapping the database fails", async () => {
    await target.fogStore.beginImport(
      { uri: "file:///picked/Sync.zip", name: "old.zip" },
      "picker",
    );
    await target.fogStore.promotePending();
    const r = restore({
      replaceDatabase: async () => {
        throw new Error("disk full");
      },
    });
    await expect(r.run()).rejects.toThrow("disk full");
    expect((await target.fogStore.current())?.name).toBe("old.zip");
    expect(await target.fogStore.pending()).toBeNull();
    expect(r.apply).not.toHaveBeenCalled();
    expect(target.scratch.left()).toEqual([]);
  });

  it("leaves the database alone when staging the import fails", async () => {
    const r = restore({
      fogStore: {
        ...target.fogStore,
        beginImport: async () => {
          throw new Error("no space");
        },
      },
    });
    await expect(r.run()).rejects.toThrow("no space");
    expect(await ids(target)).toEqual([OTHER_ID]);
    expect(r.apply).not.toHaveBeenCalled();
    expect(target.scratch.left()).toEqual([]);
  });

  it("tells the page to reload, with a distinct result, when the fog cannot follow the swap", async () => {
    const r = restore({
      fogStore: {
        ...target.fogStore,
        promotePending: async () => {
          throw new Error("rename failed");
        },
      },
    });
    expect(await r.run()).toBe("fogNotReplaced");
    // The history is the backup's by now; the fog is untouched: nothing is promoted and the import stays pending.
    expect(await ids(target)).toEqual([activity().id]);
    expect(await target.fogStore.current()).toBeNull();
    expect((await target.fogStore.pending())?.name).toBe("Sync.zip");
    expect(r.apply).not.toHaveBeenCalled();
    expect(target.scratch.left()).toEqual([]);
  });

  it("discards the pending import when staging it fails halfway", async () => {
    const discard = vi.fn(async () => {});
    const r = restore({
      fogStore: {
        ...target.fogStore,
        beginImport: async () => {
          throw new Error("no space");
        },
        discardPending: discard,
      },
    });
    await expect(r.run()).rejects.toThrow("no space");
    expect(discard).toHaveBeenCalledOnce();
  });

  it("keeps the outcome when removing the scratch files fails", async () => {
    const r = restore({
      scratch: {
        ...target.scratch,
        remove: async () => {
          throw new Error("locked");
        },
      },
    });
    expect(await r.run()).toBe("restored");
  });

  it("ignores settings in the backup that are not f2m_ keys", async () => {
    backupFile = await makeBackup({ kind: "passphrase", passphrase: PASS }, '{"evil":"x"}');
    const r = restore();
    expect(await r.run()).toBe("restored");
    expect(r.apply).not.toHaveBeenCalled();
  });

  it("says the settings were not applied when the page never confirms them", async () => {
    const r = restore({
      settings: {
        apply: async () => {
          throw new Error("the page settings did not arrive");
        },
      },
    });
    expect(await r.run()).toBe("settingsNotApplied");
    expect(await ids(target)).toEqual([activity().id]);
  });

  it("refuses before copying when the picked file needs more room than is free", async () => {
    const copy = vi.fn(async () => ({ size: 0, head: "" }));
    const r = restore({
      pickFile: async () => ({ uri: "content://downloads/b.db", name: "b.db", size: 1000 }),
      copyFromUri: copy,
      scratch: { ...target.scratch, freeBytes: async () => 4999 },
    });
    expect(await r.run()).toBe("noSpace");
    expect(copy).not.toHaveBeenCalled();
    expect(await ids(target)).toEqual([OTHER_ID]);
  });

  it("refuses after the copy when a file of unknown size turns out too big, and removes the copy", async () => {
    const r = restore({
      // The copy itself has taken its share by now; the rest still needs four times its size.
      scratch: { ...target.scratch, freeBytes: async () => 4 * 8192 - 1 },
    });
    expect(await r.run()).toBe("noSpace");
    expect(r.askPassphrase).not.toHaveBeenCalled();
    expect(await ids(target)).toEqual([OTHER_ID]);
    expect(target.scratch.left()).toEqual([]);
  });

  it.each([undefined, 8192])(
    "refuses when the free space cannot be read (picked size %s)",
    async (size) => {
      const copy = vi.fn(async () => ({ size: 8192, head: NOT_PLAIN }));
      const r = restore({
        pickFile: async () => ({
          uri: "content://downloads/b.db",
          name: "b.db",
          ...(size === undefined ? {} : { size }),
        }),
        copyFromUri: copy,
        scratch: { ...target.scratch, freeBytes: async () => Number.NaN },
      });
      expect(await r.run()).toBe("noSpace");
      expect(copy).toHaveBeenCalledTimes(size === undefined ? 1 : 0);
    },
  );

  it("restores when the free space is exactly enough", async () => {
    const r = restore({
      pickFile: async () => ({ uri: "content://downloads/b.db", name: "b.db", size: 8192 }),
      scratch: { ...target.scratch, freeBytes: async () => 5 * 8192 },
    });
    expect(await r.run()).toBe("restored");
  });
});
