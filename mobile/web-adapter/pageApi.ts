import type { ExportChunk, NativeToWeb, RouteRecord } from "../src/bridge/protocol.js";
import type { Send } from "./bridge.js";

type PageMessage<E extends PageEvent> = Extract<NativeToWeb, { type: E }>;

// The one list of native-to-page events: the listener table, `isPageMessage` and the session's routing all follow it.
const PAGE_EVENTS = [
  "routeStatus",
  "linkStatus",
  "activities",
  "track",
  "trackUnavailable",
  "unreadableActivities",
] as const;

type PageEvent = (typeof PAGE_EVENTS)[number];

// True for a message the page API delivers to `window.crossfog.on` listeners.
export function isPageMessage(msg: NativeToWeb): msg is PageMessage<PageEvent> {
  return (PAGE_EVENTS as readonly string[]).includes(msg.type);
}

// The page never sees the bridge envelope (`v`, `type`), only the payload.
type PageListener<E extends PageEvent> = (payload: Omit<PageMessage<E>, "v" | "type">) => void;

interface CrossfogApi {
  sendRoute(route: RouteRecord): void;
  needTrack(activityId: string): void;
  deleteActivity(activityId: string): void;
  exportBinary(chunk: ExportChunk): void;
  backup(): void;
  restore(): void;
  on<E extends PageEvent>(event: E, fn: PageListener<E>): () => void;
}

declare global {
  interface Window {
    crossfog?: CrossfogApi;
  }
}

export interface PageApi {
  dispatch(msg: NativeToWeb): void;
}

export function installPageApi(win: Window, send: Send): PageApi {
  type Entry = { fn: (payload: never) => void };
  const listeners = Object.fromEntries(PAGE_EVENTS.map((e) => [e, new Set<Entry>()])) as Record<
    PageEvent,
    Set<Entry>
  >;

  function on<E extends PageEvent>(event: E, fn: PageListener<E>): () => void {
    const entry: Entry = { fn };
    listeners[event].add(entry);
    return () => {
      listeners[event].delete(entry);
    };
  }

  win.crossfog = {
    sendRoute: (route) => send({ v: 1, type: "sendRoute", route }),
    needTrack: (activityId) => send({ v: 1, type: "needTrack", activityId }),
    deleteActivity: (activityId) => send({ v: 1, type: "deleteActivity", activityId }),
    exportBinary: (chunk) => send({ ...chunk, v: 1, type: "exportBinary" }),
    backup: () => send({ v: 1, type: "backup" }),
    restore: () => send({ v: 1, type: "restore" }),
    on,
  };

  function emit(event: PageEvent, payload: object): void {
    // Iterate a copy: a listener added during dispatch must not receive this message, and one that
    // re-subscribes on every call must not loop.
    for (const { fn } of [...listeners[event]]) {
      try {
        (fn as (p: object) => void)(payload);
      } catch (err) {
        // A throwing listener must not stop the others or reach the caller of dispatch. Only the event
        // name is logged: the payload carries positions, which must not reach logs.
        console.error(
          `crossfog: a ${event} listener threw ${err instanceof Error ? err.name : typeof err}`,
        );
      }
    }
  }

  return {
    dispatch(msg) {
      if (!isPageMessage(msg)) return;
      const { v: _v, type, ...payload } = msg;
      emit(type, payload);
    },
  };
}
