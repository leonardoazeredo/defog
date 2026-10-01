export type LoadOutcome =
  | { ok: true; tiles: number }
  | { ok: false; reason: "unzip" | "noTiles" | "memory" | "unknown" };

export interface OutcomeHooks {
  // arm(): arms the hook for one load cycle and returns a promise that
  // settles when unzip completes or timeoutMs elapses.
  arm(): Promise<LoadOutcome>;
}

export type AssignFiles = (input: HTMLInputElement, file: File) => void;

export const assignFilesWithDataTransfer: AssignFiles = (input, file) => {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
};

// installOutcomeHooks monkey-patches the app's FogZip.unzip and
// FogParser.FogMap.prototype.addTile globals so the adapter can observe load
// outcomes without being wired directly into the app's source. It is called
// once per window (the patches accumulate); call arm() before each load.
export function installOutcomeHooks(win: Window, timeoutMs = 30_000): OutcomeHooks {
  const winAny = win as unknown as Record<string, unknown>;

  const FogZip = winAny.FogZip as { unzip?: unknown } | undefined;
  if (typeof FogZip?.unzip !== "function") {
    throw new Error("adapter contract: FogZip.unzip missing");
  }

  const FogParser = winAny.FogParser as
    | { FogMap?: { prototype?: { addTile?: unknown } } }
    | undefined;
  if (typeof FogParser?.FogMap?.prototype?.addTile !== "function") {
    throw new Error("adapter contract: FogParser.FogMap.prototype.addTile missing");
  }

  let added = 0;
  let armed = false;
  let settle: ((outcome: LoadOutcome) => void) | null = null;

  const origUnzip = FogZip.unzip as (buf: ArrayBuffer) => unknown[];
  const origAddTile = FogParser.FogMap.prototype.addTile as (
    this: unknown,
    name: string,
    data: Uint8Array,
  ) => boolean;

  FogParser.FogMap.prototype.addTile = function (
    this: unknown,
    name: string,
    data: Uint8Array,
  ): boolean {
    const r = origAddTile.call(this, name, data);
    if (r) added++;
    return r;
  };

  FogZip.unzip = (buf: ArrayBuffer): unknown[] => {
    if (!armed) return origUnzip(buf);
    const start = added;
    let entries: unknown[];
    try {
      entries = origUnzip(buf);
    } catch (e) {
      doSettle(
        e instanceof RangeError ? { ok: false, reason: "memory" } : { ok: false, reason: "unzip" },
      );
      throw e;
    }
    setTimeout(() => {
      const n = added - start;
      doSettle(n > 0 ? { ok: true, tiles: n } : { ok: false, reason: "noTiles" });
    }, 0);
    return entries;
  };

  function doSettle(outcome: LoadOutcome): void {
    if (settle == null) return;
    armed = false;
    const s = settle;
    settle = null;
    s(outcome);
  }

  return {
    arm(): Promise<LoadOutcome> {
      armed = true;
      return new Promise<LoadOutcome>((resolve) => {
        settle = resolve;
        const timer = setTimeout(() => {
          doSettle({ ok: false, reason: "unknown" });
        }, timeoutMs);
        const origSettle = settle;
        settle = (outcome) => {
          clearTimeout(timer);
          origSettle(outcome);
        };
      });
    },
  };
}

export function loadCopy(
  bytes: Uint8Array,
  name: string,
  deps: {
    zipInput: HTMLInputElement;
    hooks: OutcomeHooks;
    assignFiles: AssignFiles;
  },
): Promise<LoadOutcome> {
  const p = deps.hooks.arm();
  deps.assignFiles(
    deps.zipInput,
    new File([bytes as Uint8Array<ArrayBuffer>], name, { type: "application/zip" }),
  );
  deps.zipInput.dispatchEvent(new Event("change", { bubbles: true }));
  return p;
}
