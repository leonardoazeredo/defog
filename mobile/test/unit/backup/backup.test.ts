import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackupFlow } from "../../../src/backup/backup.js";
import { BackupError, type PassphraseAnswer } from "../../../src/backup/types.js";
import { NotADatabaseError } from "../../../src/db/driver.js";
import { createHarness, type Harness, ZIP_BYTES } from "../../support/backupHarness.js";
import { copyNodeBackup, openNodeBackup } from "../../support/nodeSqliteDriver.js";

const NOW = new Date(2026, 9, 22, 12).getTime();
const SETTINGS = '{"f2m_units":"imperial"}';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.seed();
});
afterEach(() => h.cleanup());

function flow(
  answer: PassphraseAnswer | null,
  over: Partial<Parameters<typeof createBackupFlow>[0]> = {},
) {
  const saved: string[] = [];
  const saveAs = vi.fn(async (path: string, name: string) => {
    const dest = join(h.dir, name);
    copyNodeBackup(path, dest);
    saved.push(dest);
    return { name };
  });
  const confirmUnencrypted = vi.fn(async () => true);
  const askPassphrase = vi.fn(async () => answer);
  const settings = { request: vi.fn(async () => SETTINGS) };
  const f = createBackupFlow({
    withDb: (fn) => h.gate.shared(() => fn(h.db)),
    openBackup: openNodeBackup,
    fogStore: h.fogStore,
    fs: h.fs,
    scratch: h.scratch,
    settings,
    askPassphrase,
    confirmUnencrypted,
    saveAs,
    now: () => NOW,
    ...over,
  });
  return { f, saved, saveAs, confirmUnencrypted, askPassphrase, settings };
}

const count = async (b: Awaited<ReturnType<typeof openNodeBackup>>, table: string) =>
  (await b.all<{ n: number }>(`SELECT count(*) AS n FROM backup.${table}`))[0]?.n;

describe("backup flow", () => {
  it("saves a passphrase-keyed copy with the stores, the import zip and the settings", async () => {
    const { f, saved, saveAs } = flow({ kind: "passphrase", passphrase: "correct horse" });
    expect(await f.run()).toEqual({ status: "saved", name: "crossfog-backup-2026-10-22.db" });

    expect(saveAs).toHaveBeenCalledWith(
      expect.stringContaining("crossfog-backup-2026-10-22.db"),
      "crossfog-backup-2026-10-22.db",
      "application/octet-stream",
    );
    const b = await openNodeBackup(saved[0] as string, "correct horse");
    expect(
      (await b.all<{ user_version: number }>("PRAGMA backup.user_version"))[0]?.user_version,
    ).toBe(1);
    expect(await count(b, "activities")).toBe(1);
    expect(await count(b, "routes")).toBe(1);
    const blobs = await b.all<{ kind: string; name: string; bytes: Uint8Array }>(
      "SELECT kind, name, bytes FROM backup.blobs ORDER BY kind",
    );
    expect(blobs.map((r) => [r.kind, r.name])).toEqual([
      ["import", "Sync.zip"],
      ["page_settings", "f2m"],
    ]);
    expect(new Uint8Array(blobs[0]?.bytes as Uint8Array)).toEqual(ZIP_BYTES);
    expect(new TextDecoder().decode(blobs[1]?.bytes as Uint8Array)).toBe(SETTINGS);
    await b.close();
  });

  it("holds nothing but the three tables, so no cache can be in it", async () => {
    const { f, saved } = flow({ kind: "passphrase", passphrase: "correct horse" });
    await f.run();
    const b = await openNodeBackup(saved[0] as string, "correct horse");
    const tables = await b.all<{ name: string }>(
      "SELECT name FROM backup.sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual(["activities", "blobs", "routes"]);
    await b.close();
  });

  it("refuses the file with a wrong passphrase", async () => {
    const { f, saved } = flow({ kind: "passphrase", passphrase: "correct horse" });
    await f.run();
    await expect(openNodeBackup(saved[0] as string, "wrong")).rejects.toBeInstanceOf(
      NotADatabaseError,
    );
  });

  it("leaves the live database without blobs", async () => {
    await flow({ kind: "passphrase", passphrase: "correct horse" }).f.run();
    expect(await h.db.all("SELECT * FROM blobs")).toEqual([]);
  });

  it("writes the settings only when no import exists", async () => {
    await h.fogStore.clear();
    const { f, saved } = flow({ kind: "passphrase", passphrase: "correct horse" });
    await f.run();
    const b = await openNodeBackup(saved[0] as string, "correct horse");
    expect(
      (await b.all<{ kind: string }>("SELECT kind FROM backup.blobs")).map((r) => r.kind),
    ).toEqual(["page_settings"]);
    await b.close();
  });

  it("asks the unencrypted warning before it writes a plaintext file", async () => {
    const order: string[] = [];
    const { f, saved } = flow(
      { kind: "none" },
      {
        confirmUnencrypted: async () => {
          order.push("warned");
          return true;
        },
        saveAs: async (path, name) => {
          order.push("saved");
          copyNodeBackup(path, join(h.dir, name));
          return { name };
        },
      },
    );
    expect((await f.run()).status).toBe("saved");
    expect(order).toEqual(["warned", "saved"]);
    expect(saved).toEqual([]);
    const b = await openNodeBackup(join(h.dir, "crossfog-backup-2026-10-22.db"), null);
    expect(await count(b, "activities")).toBe(1);
    await b.close();
  });

  it("writes nothing when the unencrypted warning is declined", async () => {
    const { f, saveAs } = flow({ kind: "none" }, { confirmUnencrypted: async () => false });
    expect(await f.run()).toEqual({ status: "cancelled" });
    expect(saveAs).not.toHaveBeenCalled();
    expect(h.scratch.left()).toEqual([]);
  });

  it("writes nothing and asks nothing more when the dialog is cancelled", async () => {
    const { f, saveAs, settings } = flow(null);
    expect(await f.run()).toEqual({ status: "cancelled" });
    expect(saveAs).not.toHaveBeenCalled();
    expect(settings.request).not.toHaveBeenCalled();
    expect(h.scratch.left()).toEqual([]);
  });

  it("deletes the temporary file when the picker is cancelled", async () => {
    const { f } = flow(
      { kind: "passphrase", passphrase: "correct horse" },
      { saveAs: async () => null },
    );
    expect(await f.run()).toEqual({ status: "cancelled" });
    expect(h.scratch.left()).toEqual([]);
  });

  it("deletes the temporary file when saving fails", async () => {
    const { f } = flow(
      { kind: "passphrase", passphrase: "correct horse" },
      {
        saveAs: async () => {
          throw new Error("disk");
        },
      },
    );
    await expect(f.run()).rejects.toThrow("disk");
    expect(h.scratch.left()).toEqual([]);
  });

  it("refuses when free space is under three times the database", async () => {
    const small = await createHarness({ free: 3 * 4096 - 1 });
    const saveAs = vi.fn();
    const f = createBackupFlow({
      withDb: (fn) => fn(small.db),
      openBackup: openNodeBackup,
      fogStore: small.fogStore,
      fs: small.fs,
      scratch: small.scratch,
      settings: { request: async () => SETTINGS },
      askPassphrase: async () => ({ kind: "passphrase", passphrase: "correct horse" }),
      confirmUnencrypted: async () => true,
      saveAs,
      now: () => NOW,
    });
    await expect(f.run()).rejects.toMatchObject({ code: "noSpace" });
    expect(saveAs).not.toHaveBeenCalled();
    expect(small.scratch.left()).toEqual([]);
    small.cleanup();
  });

  it("refuses when the database size is unknown rather than letting the check pass", async () => {
    const f = createBackupFlow({
      withDb: (fn) => h.gate.shared(() => fn(h.db)),
      openBackup: openNodeBackup,
      fogStore: h.fogStore,
      fs: h.fs,
      scratch: { ...h.scratch, databaseBytes: async () => Number.NaN },
      settings: { request: async () => SETTINGS },
      askPassphrase: async () => ({ kind: "passphrase", passphrase: "correct horse" }),
      confirmUnencrypted: async () => true,
      saveAs: async () => null,
      now: () => NOW,
    });
    await expect(f.run()).rejects.toMatchObject({ code: "noSpace" });
  });

  it("keeps a saved backup saved when removing the temporary file fails", async () => {
    const { f } = flow(
      { kind: "passphrase", passphrase: "correct horse" },
      {
        scratch: {
          ...h.scratch,
          remove: async (p: string) => {
            if (p.endsWith(".db")) throw new Error("locked");
          },
        },
      },
    );
    expect((await f.run()).status).toBe("saved");
  });

  it("fails without a file when the page does not give its settings", async () => {
    const { f, saveAs } = flow(
      { kind: "passphrase", passphrase: "correct horse" },
      {
        settings: {
          request: async () => {
            throw new Error("the page settings did not arrive");
          },
        },
      },
    );
    await expect(f.run()).rejects.toBeInstanceOf(BackupError);
    expect(saveAs).not.toHaveBeenCalled();
    expect(h.scratch.left()).toEqual([]);
  });
});
