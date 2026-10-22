import { describe, expect, it } from "vitest";
import { createGate } from "../../../src/db/gate.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("gate", () => {
  it("lets shared users overlap", async () => {
    const gate = createGate();
    const a = deferred();
    const log: string[] = [];
    const first = gate.shared(async () => {
      log.push("a in");
      await a.promise;
      log.push("a out");
    });
    await gate.shared(async () => log.push("b"));
    expect(log).toEqual(["a in", "b"]);
    a.resolve();
    await first;
  });

  it("makes an exclusive user wait for the running shared users", async () => {
    const gate = createGate();
    const a = deferred();
    const log: string[] = [];
    const shared = gate.shared(async () => {
      await a.promise;
      log.push("shared done");
    });
    const exclusive = gate.exclusive(async () => log.push("exclusive"));
    await Promise.resolve();
    expect(log).toEqual([]);
    a.resolve();
    await Promise.all([shared, exclusive]);
    expect(log).toEqual(["shared done", "exclusive"]);
  });

  it("holds shared users that arrive while an exclusive one is running", async () => {
    const gate = createGate();
    const hold = deferred();
    const log: string[] = [];
    const exclusive = gate.exclusive(async () => {
      log.push("exclusive in");
      await hold.promise;
      log.push("exclusive out");
    });
    const late = gate.shared(async () => log.push("late"));
    await Promise.resolve();
    hold.resolve();
    await Promise.all([exclusive, late]);
    expect(log).toEqual(["exclusive in", "exclusive out", "late"]);
  });

  it("runs exclusive users one at a time and survives a throw", async () => {
    const gate = createGate();
    await expect(
      gate.exclusive(async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(await gate.exclusive(async () => 7)).toBe(7);
    expect(await gate.shared(async () => 8)).toBe(8);
  });
});
