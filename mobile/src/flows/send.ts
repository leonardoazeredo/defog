import type { NativeToWeb, RouteRecord } from "../bridge/protocol.js";
import { COPY } from "../copy.js";
import type { RouteStore } from "../history/types.js";
import type { LinkStatus, WatchLink } from "../link/types.js";
import { warnClass } from "./warn.js";

export interface SendDeps {
  link: Pick<WatchLink, "queueRoute" | "status" | "on">;
  routes: Pick<RouteStore, "save" | "markSent">;
  send(msg: NativeToWeb): void;
}

export interface SendFlow {
  /** Never rejects: a failed save or queue reaches the page as a `failed` route status. */
  sendRoute(route: RouteRecord): Promise<void>;
  /** Tells the page the current link status, for a page that has just loaded. */
  sendStatus(): Promise<void>;
  /** Starts forwarding link events to the page; returns the function that stops it. */
  start(): () => void;
}

const warn = (what: string, e: unknown) => warnClass("send", what, e);

type RouteState = Extract<NativeToWeb, { type: "routeStatus" }>["state"];

function routeStatus(routeId: string, state: RouteState, why?: string): NativeToWeb {
  return { v: 1, type: "routeStatus", routeId, state, ...(why === undefined ? {} : { why }) };
}

function linkStatus({ paired, reachable }: LinkStatus): NativeToWeb {
  return { v: 1, type: "linkStatus", paired, reachable };
}

export function createSendFlow(deps: SendDeps): SendFlow {
  const { link, routes } = deps;

  function send(msg: NativeToWeb): void {
    try {
      deps.send(msg);
    } catch (e) {
      warn("could not reach the page", e);
    }
  }

  return {
    async sendRoute(route) {
      try {
        await routes.save(route);
        await link.queueRoute(route);
      } catch (e) {
        warn("could not queue a route", e);
        send(routeStatus(route.id, "failed", COPY.routeNotSent));
        return;
      }
      send(routeStatus(route.id, "waiting"));
    },

    async sendStatus() {
      let status: LinkStatus;
      try {
        status = await link.status();
      } catch (e) {
        warn("could not read the link status", e);
        return;
      }
      send(linkStatus(status));
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
          send(routeStatus(routeId, "onWatch"));
        })();
      });
      const offStatus = link.on("linkStatus", (status) => send(linkStatus(status)));
      return () => {
        offRoute();
        offStatus();
      };
    },
  };
}
