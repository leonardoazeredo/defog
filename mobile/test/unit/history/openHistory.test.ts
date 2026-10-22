import { describe, expect, it, vi } from "vitest";
import type { SqlDriver } from "../../../src/db/driver.js";
import { type OpenHistoryDeps, openHistory } from "../../../src/db/openHistory.js";

const driver = (): SqlDriver => ({
  exec: vi.fn(),
  exportTo: vi.fn(),
  run: vi.fn(),
  all: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn(async () => {}),
});

function deps(over: Partial<OpenHistoryDeps> = {}): OpenHistoryDeps {
  const db = driver();
  return {
    keyState: async () => "existing",
    getDatabaseKeyHex: async () => "ab".repeat(32),
    databaseExists: () => true,
    openDriver: vi.fn(async () => db),
    migrate: vi.fn(async () => 1),
    isKeyLostError: (e) => e instanceof Error && e.name === "KeyLostError",
    ...over,
  };
}

describe("openHistory", () => {
  it("opens and migrates when the key exists", async () => {
    const d = deps();
    const r = await openHistory(d);
    expect(r.kind).toBe("ready");
    expect(d.migrate).toHaveBeenCalledOnce();
  });

  it("creates a database on the very first start", async () => {
    const r = await openHistory(
      deps({ keyState: async () => "fresh", databaseExists: () => false }),
    );
    expect(r.kind).toBe("ready");
  });

  it("reports a lost key instead of creating an empty database when one is on disk", async () => {
    const d = deps({ keyState: async () => "fresh", databaseExists: () => true });
    expect((await openHistory(d)).kind).toBe("keyLost");
    expect(d.openDriver).not.toHaveBeenCalled();
  });

  it("reports a lost key state without asking for the key", async () => {
    const get = vi.fn(async () => "ab".repeat(32));
    const d = deps({ keyState: async () => "lost", getDatabaseKeyHex: get });
    expect((await openHistory(d)).kind).toBe("keyLost");
    expect(get).not.toHaveBeenCalled();
  });

  it("reports a lost key when reading it fails with the lost-key error", async () => {
    const lost = Object.assign(new Error("gone"), { name: "KeyLostError" });
    const d = deps({
      getDatabaseKeyHex: async () => {
        throw lost;
      },
    });
    expect((await openHistory(d)).kind).toBe("keyLost");
    expect(d.openDriver).not.toHaveBeenCalled();
  });

  it("passes other key errors on", async () => {
    const d = deps({
      getDatabaseKeyHex: async () => {
        throw new Error("keystore busy");
      },
    });
    await expect(openHistory(d)).rejects.toThrow("keystore busy");
  });

  it("closes the connection when the migration fails", async () => {
    const db = driver();
    const d = deps({
      openDriver: async () => db,
      migrate: async () => {
        throw new Error("bad");
      },
    });
    await expect(openHistory(d)).rejects.toThrow("bad");
    expect(db.close).toHaveBeenCalled();
  });
});
