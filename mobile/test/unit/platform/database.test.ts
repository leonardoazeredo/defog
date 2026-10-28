import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_DB, REPLACED_DB } from "../../../src/backup/replace.js";
import type { NotADatabaseError, SqlDriver } from "../../../src/db/driver.js";
import { checkedKeyHex } from "../../../src/db/keyHex.js";

// File contents by name in the SQLite directory; a move carries the contents, so a test can tell
// which file was opened.
const disk = new Map<string, string>();
const opened: string[] = [];
let openFile: (contents: string) => Promise<SqlDriver>;
let readKey: () => Promise<string>;

vi.mock("expo-file-system", () => ({
  Paths: { document: "doc" },
  File: class {
    readonly name: string;
    constructor(...parts: string[]) {
      this.name = parts.at(-1) ?? "";
    }
    get exists() {
      return disk.has(this.name);
    }
  },
}));
vi.mock("../../../src/platform/backupPlatform.js", () => ({
  createDatabaseFiles: () => ({
    pathOf: (name: string) => name,
    exists: (name: string) => disk.has(name),
    remove: (name: string) => disk.delete(name),
    move(from: string, to: string) {
      disk.set(to, disk.get(from) ?? "");
      disk.delete(from);
    },
  }),
}));
// Hoisted so the factory, rerun by each vi.resetModules, hands out the spy the test checks.
const { resetKeys, KeyUnavailableError } = vi.hoisted(() => ({
  resetKeys: vi.fn(async () => {}),
  KeyUnavailableError: class KeyUnavailableError extends Error {},
}));
vi.mock("../../../src/platform/watchLinkModule.js", () => ({
  KeyLostError: class extends Error {},
  KeyUnavailableError,
  keyState: async () => "existing",
  getDatabaseKeyHex: () => readKey(),
  resetKeys,
}));
vi.mock("../../../src/platform/expoSqliteDriver.js", () => ({
  createExpoSqliteDriver: async ({ name }: { name: string }) => {
    const contents = disk.get(name) ?? "";
    opened.push(contents);
    return openFile(contents);
  },
}));
vi.mock("../../../src/db/schema.js", () => ({ migrate: async () => 1 }));

const driver = (): SqlDriver => ({
  exec: vi.fn(),
  exportTo: vi.fn(),
  run: vi.fn(),
  all: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn(async () => {}),
});
// Built from the module graph the code under test loaded, so its `instanceof` holds.
let NotADb: typeof NotADatabaseError;
const wrongKey = () => new NotADb("file is not a database");

async function createDatabase() {
  // The module keeps the open and the first-open flag per process; each test starts from freshly
  // imported modules, as a new process would.
  vi.resetModules();
  ({ NotADatabaseError: NotADb } = await import("../../../src/db/driver.js"));
  return (await import("../../../src/platform/database.js")).createDatabase();
}

beforeEach(() => {
  readKey = async () => checkedKeyHex("ab".repeat(32));
  disk.clear();
  opened.length = 0;
});

describe("createDatabase with a key that does not open the file", () => {
  it("reports key-lost rather than a failed open", async () => {
    disk.set(LIVE_DB, "live");
    openFile = async () => {
      throw wrongKey();
    };
    await expect(createDatabase()).resolves.toEqual({ kind: "keyLost" });
    expect(disk.get(LIVE_DB)).toBe("live");
  });

  it("puts a replaced copy back and opens it when the live file will not open with the key", async () => {
    disk.set(LIVE_DB, "restored");
    disk.set(REPLACED_DB, "old");
    openFile = async (contents) => {
      if (contents === "restored") throw wrongKey();
      return driver();
    };
    expect((await createDatabase()).kind).toBe("ready");
    expect(opened).toEqual(["restored", "old"]);
    expect(disk.get(LIVE_DB)).toBe("old");
  });

  it("reports key-lost when the put-back copy does not open either", async () => {
    disk.set(LIVE_DB, "restored");
    disk.set(REPLACED_DB, "old");
    openFile = async () => {
      throw wrongKey();
    };
    await expect(createDatabase()).resolves.toEqual({ kind: "keyLost" });
    expect(opened).toEqual(["restored", "old"]);
  });

  it("passes any other failure on", async () => {
    disk.set(LIVE_DB, "live");
    openFile = async () => {
      throw new Error("disk full");
    };
    await expect(createDatabase()).rejects.toThrow("disk full");
  });

  it("rejects, never reporting key-lost, when the native side cannot reach the key", async () => {
    disk.set(LIVE_DB, "live");
    resetKeys.mockClear();
    const unavailable = new KeyUnavailableError();
    readKey = async () => {
      throw unavailable;
    };
    openFile = async () => driver();
    await expect(createDatabase()).rejects.toBe(unavailable);
    expect(disk.get(LIVE_DB)).toBe("live");
    expect(resetKeys).not.toHaveBeenCalled();
  });
});
