import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as fflate from "fflate";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findAppSrc(): string {
  // Walk up to the repo root where app/ and mobile/ sit side-by-side.
  // The extra levels handle Stryker's .stryker-tmp/ sandbox nesting.
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    dir = resolve(dir, "..");
    const candidate = resolve(dir, "app/src");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`app/src not found (searched up from ${__dirname})`);
}

const APP_SRC = findAppSrc();

// installFakeUpstream loads the upstream app's unzip.js and parser.js into the
// test window via eval (the same way the mobile webview hosts them) and wires
// up the same "zip input change" listener the real app uses. pako is shimmed
// with fflate since pako is not available in Node.
export function installFakeUpstream(win: Window, doc: Document): void {
  const winAny = win as unknown as Record<string, unknown>;

  winAny.pako = {
    inflateRaw: (data: Uint8Array) => fflate.inflateSync(data),
    inflate: (data: Uint8Array) => fflate.unzlibSync(data),
  };

  win.eval(readFileSync(resolve(APP_SRC, "unzip.js"), "utf-8"));
  win.eval(readFileSync(resolve(APP_SRC, "parser.js"), "utf-8"));

  const FogParser = winAny.FogParser as {
    FogMap: new () => { addTile(name: string, data: Uint8Array): boolean };
  };
  const FogZip = winAny.FogZip as {
    unzip(buf: ArrayBuffer): Array<{ name: string; data: Uint8Array }>;
  };

  const fogMap = new FogParser.FogMap();

  doc.getElementById("zip")?.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    let entries: Array<{ name: string; data: Uint8Array }>;
    try {
      entries = FogZip.unzip(buf);
    } catch {
      return;
    }
    for (const ent of entries) {
      const base = ent.name.split(/[\\/]/).pop() ?? "";
      try {
        fogMap.addTile(base, fflate.unzlibSync(ent.data));
      } catch {}
    }
  });
}
