import type { Activity, ActivityStore, RouteStore, RouteSummary, StoredRoute } from "./types.js";

const copy = <T>(v: T): T => structuredClone(v);

function newestFirst(a: { at: string; id: string }, b: { at: string; id: string }): number {
  return Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

export function createMemoryActivityStore(): ActivityStore {
  const byId = new Map<string, Activity>();
  return {
    async add(a) {
      if (byId.has(a.id)) return { stored: false };
      byId.set(a.id, copy(a));
      return { stored: true };
    },
    async list() {
      return [...byId.values()]
        .sort((a, b) => newestFirst({ at: a.startedAt, id: a.id }, { at: b.startedAt, id: b.id }))
        .map(({ id, travelMode, startedAt, endedAt, routeId, stats }) =>
          copy({
            id,
            travelMode,
            startedAt,
            endedAt,
            ...(routeId === undefined ? {} : { routeId }),
            stats,
          }),
        );
    },
    async get(id) {
      const a = byId.get(id);
      if (!a) return null;
      const { gpx: _gpx, ...detail }: Activity = a;
      return copy(detail);
    },
    async gpx(id) {
      return byId.get(id)?.gpx ?? null;
    },
    async delete(id) {
      return byId.delete(id);
    },
  };
}

export function createMemoryRouteStore(deps: { now?: () => Date } = {}): RouteStore {
  const now = deps.now ?? (() => new Date());
  const byId = new Map<string, StoredRoute>();
  return {
    async save(r) {
      // Only markSent sets sentAt, as in the SQL store.
      const { sentAt: _sent, ...unsent } = r as StoredRoute;
      byId.set(r.id, copy(unsent));
    },
    async get(id) {
      const r = byId.get(id);
      return r ? copy(r) : null;
    },
    async list() {
      return [...byId.values()]
        .sort((a, b) => newestFirst({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }))
        .map(({ waypoints: _w, coords: _c, gpx: _g, ...summary }): RouteSummary => copy(summary));
    },
    async markSent(id) {
      const r = byId.get(id);
      if (!r) throw new Error("unknown route");
      r.sentAt = now().toISOString();
    },
  };
}
