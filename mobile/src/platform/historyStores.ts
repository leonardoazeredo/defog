import type { SqlDriver } from "../db/driver.js";
import { createActivityStore } from "../history/activityStore.js";
import { createRouteStore } from "../history/routeStore.js";
import type { ActivityStore, RouteStore } from "../history/types.js";
import { createDatabase } from "./database.js";

// The database opens asynchronously and may be unavailable (lost key, failed open). Every call waits
// for it and rejects when there is none, so a flow leaves its work where it was and never writes
// to a database it created empty.
async function open(): Promise<SqlDriver> {
  const history = await createDatabase();
  if (history.kind !== "ready") throw new Error("history is unavailable");
  return history.db;
}

export function createHistoryStores(): { activities: ActivityStore; routes: RouteStore } {
  return {
    activities: {
      add: async (a) => createActivityStore(await open()).add(a),
      list: async () => createActivityStore(await open()).list(),
      get: async (id) => createActivityStore(await open()).get(id),
      delete: async (id) => createActivityStore(await open()).delete(id),
    },
    routes: {
      save: async (r) => createRouteStore(await open()).save(r),
      get: async (id) => createRouteStore(await open()).get(id),
      list: async () => createRouteStore(await open()).list(),
      markSent: async (id) => createRouteStore(await open()).markSent(id),
    },
  };
}
