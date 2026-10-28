import { describe, expect, it, vi } from "vitest";
import { NotADatabaseError, type SqlDriver } from "../../../src/db/driver.js";
import { checkedKeyHex } from "../../../src/db/keyHex.js";
import {
  type OpenHistoryDeps,
  openHistory,
  wrongKeyAsKeyLost,
} from "../../../src/db/openHistory.js";

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
    getDatabaseKeyHex: async () => checkedKeyHex("ab".repeat(32)),
    databaseExists: () => true,
    resetKeys: vi.fn(async () => {}),
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
    const get = vi.fn(async () => checkedKeyHex("ab".repeat(32)));
    const d = deps({ keyState: async () => "lost", getDatabaseKeyHex: get });
    expect((await openHistory(d)).kind).toBe("keyLost");
    expect(get).not.toHaveBeenCalled();
    expect(d.resetKeys).not.toHaveBeenCalled();
  });

  for (const state of ["lost", "unreadable"] as const) {
    it(`resets a ${state} key and creates a database when no database file exists`, async () => {
      const order: string[] = [];
      const d = deps({
        keyState: async () => state,
        databaseExists: () => false,
        resetKeys: vi.fn(async () => {
          order.push("reset");
        }),
        getDatabaseKeyHex: async () => {
          order.push("key");
          return checkedKeyHex("ab".repeat(32));
        },
      });
      expect((await openHistory(d)).kind).toBe("ready");
      expect(order).toEqual(["reset", "key"]);
      expect(d.migrate).toHaveBeenCalledOnce();
    });
  }

  it("reports an unreadable key without asking for it while a database file exists", async () => {
    const get = vi.fn(async () => checkedKeyHex("ab".repeat(32)));
    const d = deps({ keyState: async () => "unreadable", getDatabaseKeyHex: get });
    expect((await openHistory(d)).kind).toBe("keyLost");
    expect(get).not.toHaveBeenCalled();
    expect(d.resetKeys).not.toHaveBeenCalled();
  });

  it("passes a refused reset on without opening anything", async () => {
    const d = deps({
      keyState: async () => "lost",
      databaseExists: () => false,
      resetKeys: async () => {
        throw Object.assign(new Error("a database exists"), { code: "ERR_INVALID_STATE" });
      },
    });
    await expect(openHistory(d)).rejects.toThrow("a database exists");
    expect(d.openDriver).not.toHaveBeenCalled();
  });

  it("does not reset a key that reads as existing but fails, even with no database", async () => {
    const lost = Object.assign(new Error("gone"), { name: "KeyLostError" });
    const d = deps({
      databaseExists: () => false,
      getDatabaseKeyHex: async () => {
        throw lost;
      },
    });
    expect((await openHistory(d)).kind).toBe("keyLost");
    expect(d.resetKeys).not.toHaveBeenCalled();
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

  it("rejects with the migration's error, not the close's, when both fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = driver();
    db.close = vi.fn(async () => {
      throw new TypeError("closed twice");
    });
    const d = deps({
      openDriver: async () => db,
      migrate: async () => {
        throw new Error("bad");
      },
    });
    await expect(openHistory(d)).rejects.toThrow("bad");
    expect(warn).toHaveBeenCalledWith(expect.any(String), "TypeError");
    warn.mockRestore();
  });

  it("opens a database file that exists while keyState reads existing", async () => {
    const d = deps({ databaseExists: () => true });
    expect((await openHistory(d)).kind).toBe("ready");
    expect(d.resetKeys).not.toHaveBeenCalled();
  });

  it("opens with no database file while keyState reads existing", async () => {
    const d = deps({ databaseExists: () => false });
    expect((await openHistory(d)).kind).toBe("ready");
    expect(d.resetKeys).not.toHaveBeenCalled();
  });
});

describe("wrongKeyAsKeyLost", () => {
  it("reads a key that does not open the file as a lost key", () => {
    expect(wrongKeyAsKeyLost(new NotADatabaseError("file is not a database"))).toEqual({
      kind: "keyLost",
    });
  });

  it("passes any other failure on", () => {
    const e = new Error("disk full");
    expect(() => wrongKeyAsKeyLost(e)).toThrow(e);
  });
});
