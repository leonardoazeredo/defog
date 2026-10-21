import type { ExportChunk, RouteRecord } from "../bridge/protocol.js";

// Flows must not reject: onWebMessage awaits them with no catch, so a rejection goes unhandled.
// A flow reports its own failures to the user.
export interface Flows {
  /** The page has loaded and heard about the saved fog: send it the history and the link status. */
  ready(): Promise<void>;
  sendRoute(route: RouteRecord): Promise<void>;
  needTrack(activityId: string): Promise<void>;
  deleteActivity(activityId: string): Promise<void>;
  exportBinary(chunk: ExportChunk): Promise<void>;
  backup(): Promise<void>;
  restore(): Promise<void>;
}

export function createNoopFlows(): Flows {
  const done = () => Promise.resolve();
  return {
    ready: done,
    sendRoute: done,
    needTrack: done,
    deleteActivity: done,
    exportBinary: done,
    backup: done,
    restore: done,
  };
}
