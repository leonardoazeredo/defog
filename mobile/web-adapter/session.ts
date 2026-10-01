import type { NativeToWeb, WebToNative } from "../src/bridge/protocol.js";
import type { Send } from "./bridge.js";
import type { FogCache } from "./fogCache.js";
import type { LoadOutcome } from "./loader.js";
import { createReceiver } from "./receive.js";
import type { Status, StatusActions } from "./status.js";

export type { StatusActions };

export interface SessionDeps {
  send: Send;
  cache: FogCache;
  status: Status;
  load(bytes: Uint8Array, name: string): Promise<LoadOutcome>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
  handleBack(): boolean;
}

export function createStatusActions(send: Send): StatusActions {
  return {
    update: () => send({ v: 1, type: "pickBackup" }),
    clear: () => send({ v: 1, type: "clearSavedFog" }),
    about: () => send({ v: 1, type: "openAbout" }),
    retry: () => send({ v: 1, type: "retryRestore" }),
  };
}

export function createSession(deps: SessionDeps): { onMessage(msg: NativeToWeb): Promise<void> } {
  const { send, cache, status, load, sha256Hex, handleBack } = deps;

  type ActiveCopy = {
    fingerprint: string;
    name: string;
    savedAt: string;
    size: number;
    role: "current" | "pending";
    receiver: ReturnType<typeof createReceiver>;
    mismatches: number;
    transferred: boolean;
  };

  let active: ActiveCopy | null = null;

  async function afterLoad(
    outcome: LoadOutcome,
    meta: { fingerprint: string; name: string; savedAt: string; role: "current" | "pending" },
    transferred: boolean,
    bytes: Uint8Array,
  ): Promise<void> {
    const loaded: WebToNative = outcome.ok
      ? { v: 1, type: "loaded", fingerprint: meta.fingerprint, ok: true, tiles: outcome.tiles }
      : { v: 1, type: "loaded", fingerprint: meta.fingerprint, ok: false, reason: outcome.reason };
    send(loaded);

    if (outcome.ok) {
      status.showSaved({ name: meta.name, savedAt: meta.savedAt });
      if (transferred) {
        await cache.putOnly(meta.fingerprint, bytes);
      }
    } else if (meta.role === "current") {
      status.showRetry("failed");
    }
  }

  return {
    async onMessage(msg: NativeToWeb): Promise<void> {
      switch (msg.type) {
        case "none":
          await cache.clearAll();
          status.hide();
          break;

        case "restore": {
          const cached = await cache.get(msg.fingerprint);
          if (cached != null) {
            const outcome = await load(cached, msg.name);
            await afterLoad(outcome, msg, false, cached);
          } else {
            active = {
              fingerprint: msg.fingerprint,
              name: msg.name,
              savedAt: msg.savedAt,
              size: msg.size,
              role: msg.role,
              receiver: createReceiver(msg.fingerprint, sha256Hex),
              mismatches: 0,
              transferred: true,
            };
            send({ v: 1, type: "needBytes", fingerprint: msg.fingerprint });
            status.showProgress(0, msg.size);
          }
          break;
        }

        case "chunk":
          if (active == null || msg.fingerprint !== active.fingerprint) break;
          {
            const result = await active.receiver.accept(msg);
            if (result.kind === "partial") {
              status.showProgress(result.receivedBytes, active.size);
            } else if (result.kind === "complete") {
              const { fingerprint, name, savedAt, role, transferred } = active;
              active = null;
              const outcome = await load(result.bytes, name);
              await afterLoad(
                outcome,
                { fingerprint, name, savedAt, role },
                transferred,
                result.bytes,
              );
            } else {
              active.mismatches++;
              if (active.mismatches === 1) {
                send({ v: 1, type: "needBytes", fingerprint: active.fingerprint });
                active.receiver = createReceiver(active.fingerprint, sha256Hex);
              } else {
                const { fingerprint, role } = active;
                active = null;
                const loaded: WebToNative = {
                  v: 1,
                  type: "loaded",
                  fingerprint,
                  ok: false,
                  reason: "checksum",
                };
                send(loaded);
                if (role === "current") status.showRetry("failed");
              }
            }
          }
          break;

        case "restoreSuspended":
          status.showRetry("suspended");
          break;

        case "notice":
          status.showNotice(msg.text);
          break;

        case "back":
          send({ v: 1, type: "back:result", handled: handleBack() });
          break;
      }
    },
  };
}
