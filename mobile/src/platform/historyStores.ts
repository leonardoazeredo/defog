import type { SqlDriver } from "../db/driver.js";
import { HistoryKeyLostError } from "../db/openHistory.js";
import { createActivityStore } from "../history/activityStore.js";
import { createRouteStore } from "../history/routeStore.js";
import type { ActivityStore, RouteStore } from "../history/types.js";
import { createDatabase, historyGate } from "./database.js";

// The database opens asynchronously and may be unavailable (lost key, failed open). Every call waits
// for it and rejects when there is none, so a flow leaves its work where it was and never writes
// to a database it created empty.
async function open(): Promise<SqlDriver> {
  const history = await createDatabase();
  if (history.kind === "keyLost") throw new HistoryKeyLostError();
  return history.db;
}

/** Runs `fn` on the open database while a restore cannot swap the file away. */
export function withHistoryDb<R>(fn: (db: SqlDriver) => Promise<R>): Promise<R> {
  return historyGate.shared(async () => fn(await open()));
}

export function createHistoryStores(): { activities: ActivityStore; routes: RouteStore } {
  return {
    activities: {
      add: (a) => withHistoryDb((db) => createActivityStore(db).add(a)),
      list: () => withHistoryDb((db) => createActivityStore(db).list()),
      get: (id) => withHistoryDb((db) => createActivityStore(db).get(id)),
      gpx: (id) => withHistoryDb((db) => createActivityStore(db).gpx(id)),
      delete: (id) => withHistoryDb((db) => createActivityStore(db).delete(id)),
    },
    routes: {
      save: (r) => withHistoryDb((db) => createRouteStore(db).save(r)),
      get: (id) => withHistoryDb((db) => createRouteStore(db).get(id)),
      list: () => withHistoryDb((db) => createRouteStore(db).list()),
      markSent: (id) => withHistoryDb((db) => createRouteStore(db).markSent(id)),
    },
  };
}
