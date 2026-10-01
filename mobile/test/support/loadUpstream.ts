import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as fflate from "fflate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SRC = resolve(__dirname, "../../../app/src");

export interface UpstreamFogMap {
  tileCount: number;
  addTile(name: string, data: Uint8Array): boolean;
  isVisitedCell(cx: number, cy: number): boolean;
}

export interface UpstreamApi {
  unzip(zip: Uint8Array): Array<{ name: string; data: Uint8Array }>;
  newFogMap(): UpstreamFogMap;
  parseTileId(name: string): number | null;
}

let _cached: UpstreamApi | null = null;

function createUpstream(): UpstreamApi {
  const window: Record<string, unknown> = {};
  const pako = {
    inflateRaw: (data: Uint8Array) => fflate.inflateSync(data),
    inflate: (data: Uint8Array) => fflate.unzlibSync(data),
  };
  const context = vm.createContext({ window, TextDecoder, pako });
  vm.runInContext(readFileSync(`${APP_SRC}/unzip.js`, "utf-8"), context);
  vm.runInContext(readFileSync(`${APP_SRC}/parser.js`, "utf-8"), context);

  // biome-ignore lint/suspicious/noExplicitAny: vm context types are unknown
  const { FogZip, FogParser } = window as any;

  return {
    unzip(zip: Uint8Array) {
      const buf =
        zip.byteOffset === 0 && zip.byteLength === zip.buffer.byteLength
          ? zip.buffer
          : zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
      return FogZip.unzip(buf) as Array<{ name: string; data: Uint8Array }>;
    },
    newFogMap(): UpstreamFogMap {
      return new FogParser.FogMap() as UpstreamFogMap;
    },
    parseTileId(name: string): number | null {
      return FogParser.parseTileId(name) as number | null;
    },
  };
}

export function loadUpstream(): UpstreamApi {
  if (_cached === null) _cached = createUpstream();
  return _cached;
}

export function loadZipLikeDefog(zip: Uint8Array): {
  tiles: number;
  fogMap: UpstreamFogMap;
} {
  const up = loadUpstream();
  const fogMap = up.newFogMap();
  const entries = up.unzip(zip);
  let tiles = 0;
  for (const ent of entries) {
    const base = ent.name.split(/[\\/]/).pop() ?? "";
    try {
      if (fogMap.addTile(base, fflate.unzlibSync(ent.data))) tiles++;
    } catch {}
  }
  return { tiles, fogMap };
}
