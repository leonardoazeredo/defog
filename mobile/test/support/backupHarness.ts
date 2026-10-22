import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DatabaseFiles, LIVE_DB, type ReplaceDeps } from "../../src/backup/replace.js";
import type { Scratch } from "../../src/backup/types.js";
import type { SqlDriver } from "../../src/db/driver.js";
import { createGate, type Gate } from "../../src/db/gate.js";
import { migrate } from "../../src/db/schema.js";
import { createFogStore, type FogStore } from "../../src/fog/store.js";
import { createActivityStore } from "../../src/history/activityStore.js";
import { createRouteStore } from "../../src/history/routeStore.js";
import { activity, route } from "../unit/history/fixtures.js";
import { createMemoryFileStore, type MemoryFileStore } from "./memoryFileStore.js";
import { createNodeSqliteDriver } from "./nodeSqliteDriver.js";

export interface Harness {
  dir: string;
  /** The open history database; `replacer` closes it and opens the swapped file. */
  readonly db: SqlDriver;
  gate: Gate;
  sources: Record<string, Uint8Array>;
  files: DatabaseFiles;
  /** What `replaceDatabase` needs besides the backup. */
  replacerDeps(over?: Partial<ReplaceDeps>): ReplaceDeps;
  fs: MemoryFileStore;
  fogStore: FogStore;
  scratch: Scratch & { left(): string[] };
  /** Seeds one activity, one route and a Fog of World import. */
  seed(): Promise<{ zip: Uint8Array }>;
  cleanup(): void;
}

export const ZIP_BYTES = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8]);

export async function createHarness(opts: { free?: number } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "crossfog-backup-"));
  const scratchDir = join(dir, "cache");
  mkdirSync(scratchDir);
  const sqliteDir = join(dir, "SQLite");
  mkdirSync(sqliteDir);
  let db = createNodeSqliteDriver(join(sqliteDir, LIVE_DB));
  await migrate(db);
  const sources: Record<string, Uint8Array> = { "file:///picked/Sync.zip": ZIP_BYTES };
  const fs = createMemoryFileStore({ sources });
  const fogStore = createFogStore(fs, {
    sha256Hex: async () => "ab".repeat(32),
    now: () => Date.UTC(2026, 9, 1),
  });

  const scratch: Harness["scratch"] = {
    path: (name) => join(scratchDir, name),
    uri: (p) => p,
    writeBytes: async (p, bytes) => {
      writeFileSync(p, bytes);
      sources[p] = bytes;
    },
    remove: async (p) => rmSync(p, { force: true }),
    freeBytes: async () => opts.free ?? 10 ** 12,
    databaseBytes: async () => 4096,
    left: () => readdirSync(scratchDir),
  };

  const files: DatabaseFiles = {
    pathOf: (name) => join(sqliteDir, name),
    exists: (name) => existsSync(join(sqliteDir, name)),
    remove: (name) => rmSync(join(sqliteDir, name), { force: true }),
    move: (from, to) => renameSync(join(sqliteDir, from), join(sqliteDir, to)),
  };
  const gate = createGate();

  return {
    dir,
    get db() {
      return db;
    },
    gate,
    sources,
    files,
    replacerDeps(over = {}) {
      return {
        files,
        exclusive: gate.exclusive,
        closeLive: () => db.close(),
        reopen: async () => {
          db = createNodeSqliteDriver(join(sqliteDir, LIVE_DB));
          await migrate(db);
        },
        databaseKeyHex: async () => "ab".repeat(32),
        mintDatabaseKeyHex: async () => "cd".repeat(32),
        isKeyLost: (e) => e instanceof Error && e.name === "KeyLostError",
        openFile: async (name) => createNodeSqliteDriver(join(sqliteDir, name)),
        ...over,
      };
    },
    fs,
    fogStore,
    scratch,
    async seed() {
      await createActivityStore(db).add(activity());
      await createRouteStore(db).save(route());
      await fogStore.beginImport({ uri: "file:///picked/Sync.zip", name: "Sync.zip" }, "picker");
      await fogStore.promotePending();
      return { zip: ZIP_BYTES };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function readSavedFile(path: string): Uint8Array {
  return readFileSync(path);
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
