import type { NativeToWeb, RouteRecord } from "../bridge/protocol.js";
import { COPY } from "../copy.js";
import type { RouteStore } from "../history/types.js";
import type { WatchLink } from "../link/types.js";

export interface SendDeps {
  link: Pick<WatchLink, "queueRoute" | "status" | "on">;
  routes: Pick<RouteStore, "save" | "markSent">;
  send(msg: NativeToWeb): void;
}

export interface SendFlow {
  /** Never rejects: a failure reaches the page as a `failed` route status. */
  sendRoute(route: RouteRecord): Promise<void>;
  /** Tells the page the current link status, for a page that has just loaded. */
  sendStatus(): Promise<void>;
  /** Starts forwarding link events to the page; returns the function that stops it. */
  start(): () => void;
}

// Only the error name is logged: a route is where the owner plans to go.
function warn(what: string, e: unknown): void {
  console.warn(`crossfog: send ${what}`, e instanceof Error ? e.name : "unknown");
}

export function createSendFlow(deps: SendDeps): SendFlow {
  const { link, routes, send } = deps;

  return {
    async sendRoute(route) {
      try {
        await routes.save(route);
        await link.queueRoute(route);
      } catch (e) {
        warn("could not queue a route", e);
        send({
          v: 1,
          type: "routeStatus",
          routeId: route.id,
          state: "failed",
          why: COPY.routeNotSent,
        });
        return;
      }
      send({ v: 1, type: "routeStatus", routeId: route.id, state: "waiting" });
    },

    async sendStatus() {
      try {
        const { paired, reachable } = await link.status();
        send({ v: 1, type: "linkStatus", paired, reachable });
      } catch (e) {
        warn("could not read the link status", e);
      }
    },

    start() {
      const offRoute = link.on("routeSaved", ({ routeId }) => {
        void (async () => {
          // The watch has the route whether or not the record could be marked, so the page hears it either way.
          try {
            await routes.markSent(routeId);
          } catch (e) {
            warn("could not mark a route sent", e);
          }
          send({ v: 1, type: "routeStatus", routeId, state: "onWatch" });
        })();
      });
      const offStatus = link.on("linkStatus", ({ paired, reachable }) => {
        send({ v: 1, type: "linkStatus", paired, reachable });
      });
      return () => {
        offRoute();
        offStatus();
      };
    },
  };
}
