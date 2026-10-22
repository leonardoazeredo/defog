import type { SettingsChannel } from "../backup/settings.js";
import type { NativeToWeb } from "../bridge/protocol.js";
import { parseGpx } from "../history/gpx.js";
import type { ActivityStore, RouteStore } from "../history/types.js";
import type { WatchLink } from "../link/types.js";
import type { BackupFlows } from "./backup.js";
import type { ExportFlow } from "./exportFlow.js";
import { createHandOffFlow } from "./handOff.js";
import { createHistoryFlow } from "./history.js";
import { createSendFlow } from "./send.js";
import { createNoopFlows, type Flows } from "./types.js";

export interface ComposedFlows extends Flows {
  /** Runs the hand-off now and on every staged activity; returns the function that stops listening. */
  start(): () => void;
  /** Resolves once a hand-off pass that began after this call has finished, publishing the history if that pass stored an activity; `start` runs the same path. */
  handOffNow(): Promise<void>;
}

export interface ComposeDeps {
  link: WatchLink;
  activities: ActivityStore;
  routes: RouteStore;
  send(msg: NativeToWeb): void;
  /** Backup and restore; absent where the platform has none. */
  backup?: BackupFlows;
  settings?: SettingsChannel;
  /** The Fog of World export; absent where the platform has none. */
  exportFlow?: ExportFlow;
  now(): number;
}

export function createFlows(deps: ComposeDeps): ComposedFlows {
  const history = createHistoryFlow({
    activities: deps.activities,
    routes: deps.routes,
    send: deps.send,
  });
  const sendFlow = createSendFlow({ link: deps.link, routes: deps.routes, send: deps.send });
  const handOff = createHandOffFlow({
    link: deps.link,
    activities: deps.activities,
    parseGpx,
    now: deps.now,
  });
  // The page shows what the store holds, so it hears about every activity the hand-off adds.
  async function handOffAndPublish(): Promise<void> {
    const { stored } = await handOff.run();
    if (stored > 0) await history.publish();
  }

  return {
    ...createNoopFlows(),
    async ready() {
      await history.publish();
      await sendFlow.sendStatus();
    },
    handOffNow: handOffAndPublish,
    sendRoute: sendFlow.sendRoute,
    needTrack: history.needTrack,
    deleteActivity: history.deleteActivity,
    ...(deps.exportFlow && { exportBinary: deps.exportFlow.onChunk }),
    ...(deps.backup && { backup: deps.backup.backup, restore: deps.backup.restore }),
    ...(deps.settings && {
      settings: async (json: string) => deps.settings?.onSettings(json),
      settingsApplied: async () => deps.settings?.onApplied(),
    }),
    start() {
      const offSend = sendFlow.start();
      const offStaged = deps.link.on("activityStaged", () => void handOffAndPublish());
      void handOffAndPublish();
      return () => {
        offSend();
        offStaged();
      };
    },
  };
}
