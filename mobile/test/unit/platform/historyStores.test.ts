import { expect, it, vi } from "vitest";
import { HistoryKeyLostError } from "../../../src/db/openHistory.js";

// The real module opens SQLCipher through expo; only the open's outcome matters here.
vi.mock("../../../src/platform/database.js", async () => {
  const { createGate } = await import("../../../src/db/gate.js");
  return { createDatabase: async () => ({ kind: "keyLost" }), historyGate: createGate() };
});

const { createHistoryStores } = await import("../../../src/platform/historyStores.js");

it("rejects every store call with HistoryKeyLostError while the key is lost", async () => {
  const { activities, routes } = createHistoryStores();
  await expect(activities.list()).rejects.toBeInstanceOf(HistoryKeyLostError);
  await expect(activities.delete("a")).rejects.toBeInstanceOf(HistoryKeyLostError);
  await expect(routes.save({} as never)).rejects.toBeInstanceOf(HistoryKeyLostError);
});
