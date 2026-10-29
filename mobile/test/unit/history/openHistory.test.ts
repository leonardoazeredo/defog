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

const keyLost = () => Object.assign(new Error("gone"), { name: "KeyLostError" });

function deps(over: Partial<OpenHistoryDeps> = {}): OpenHistoryDeps {
  const db = driver();
  return {
    keyPresence: async () => "existing",
    keyState: vi.fn(async () => "existing" as const),
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
  it("opens and migrates when the key exists, reading it once and asking no state", async () => {
    const get = vi.fn(async () => checkedKeyHex("ab".repeat(32)));
    const d = deps({ getDatabaseKeyHex: get });
    const r = await openHistory(d);
    expect(r.kind).toBe("ready");
    expect(d.migrate).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(d.keyState).not.toHaveBeenCalled();
    expect(d.resetKeys).not.toHaveBeenCalled();
  });

  it("opens with no database file while the key exists", async () => {
    const d = deps({ databaseExists: () => false });
    expect((await openHistory(d)).kind).toBe("ready");
    expect(d.resetKeys).not.toHaveBeenCalled();
  });

  it("creates a database on the very first start", async () => {
    const d = deps({ keyPresence: async () => "fresh", databaseExists: () => false });
    const r = await openHistory(d);
    expect(r.kind).toBe("ready");
    expect(d.resetKeys).not.toHaveBeenCalled();
  });

  it("reports a lost key instead of creating an empty database when one is on disk", async () => {
    const d = deps({ keyPresence: async () => "fresh", databaseExists: () => true });
    expect((await openHistory(d)).kind).toBe("keyLost");
    expect(d.openDriver).not.toHaveBeenCalled();
  });

  it("reports a lost key without asking for it while a database file exists", async () => {
    const get = vi.fn(async () => checkedKeyHex("ab".repeat(32)));
    const d = deps({ keyPresence: async () => "lost", getDatabaseKeyHex: get });
    expect((await openHistory(d)).kind).toBe("keyLost");
    expect(get).not.toHaveBeenCalled();
    expect(d.resetKeys).not.toHaveBeenCalled();
  });

  it("resets a lost key and creates a database when no database file exists", async () => {
    const order: string[] = [];
    const d = deps({
      keyPresence: async () => "lost",
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

  describe("a key whose halves are both present but cannot be read", () => {
    for (const state of ["lost", "unreadable"] as const) {
      it(`resets a ${state} key and creates a database when no database file exists`, async () => {
        const order: string[] = [];
        let reads = 0;
        const d = deps({
          keyState: vi.fn(async () => state),
          databaseExists: () => false,
          resetKeys: vi.fn(async () => {
            order.push("reset");
          }),
          getDatabaseKeyHex: async () => {
            order.push("key");
            if (++reads === 1) throw keyLost();
            return checkedKeyHex("ab".repeat(32));
          },
        });
        expect((await openHistory(d)).kind).toBe("ready");
        expect(order).toEqual(["key", "reset", "key"]);
      });

      it(`reports a ${state} key while a database file exists, without resetting`, async () => {
        const d = deps({
          keyState: vi.fn(async () => state),
          getDatabaseKeyHex: async () => {
            throw keyLost();
          },
        });
        expect((await openHistory(d)).kind).toBe("keyLost");
        expect(d.resetKeys).not.toHaveBeenCalled();
        expect(d.openDriver).not.toHaveBeenCalled();
      });
    }

    it("does not reset a key that reads as existing but fails, even with no database", async () => {
      const d = deps({
        databaseExists: () => false,
        getDatabaseKeyHex: async () => {
          throw keyLost();
        },
      });
      expect((await openHistory(d)).kind).toBe("keyLost");
      expect(d.keyState).toHaveBeenCalledOnce();
      expect(d.resetKeys).not.toHaveBeenCalled();
    });

    it("reports a lost key when the read still fails after the reset", async () => {
      const d = deps({
        keyState: vi.fn(async () => "unreadable" as const),
        databaseExists: () => false,
        getDatabaseKeyHex: async () => {
          throw keyLost();
        },
      });
      expect((await openHistory(d)).kind).toBe("keyLost");
      expect(d.resetKeys).toHaveBeenCalledOnce();
    });
  });

  it("passes a refused reset on without opening anything", async () => {
    const d = deps({
      keyPresence: async () => "lost",
      databaseExists: () => false,
      resetKeys: async () => {
        throw Object.assign(new Error("a database exists"), { code: "ERR_INVALID_STATE" });
      },
    });
    await expect(openHistory(d)).rejects.toThrow("a database exists");
    expect(d.openDriver).not.toHaveBeenCalled();
  });

  it("passes other key errors on without asking the state", async () => {
    const d = deps({
      getDatabaseKeyHex: async () => {
        throw new Error("keystore busy");
      },
    });
    await expect(openHistory(d)).rejects.toThrow("keystore busy");
    expect(d.keyState).not.toHaveBeenCalled();
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
