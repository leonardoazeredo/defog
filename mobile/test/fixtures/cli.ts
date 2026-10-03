import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { largeBackup, notABackup, standardBackup } from "./make-backup.js";

const OUT = resolve(import.meta.dirname, "out");
mkdirSync(OUT, { recursive: true });

function write(name: string, data: Uint8Array) {
  writeFileSync(resolve(OUT, name), data);
  console.log(`${name}: ${data.length.toLocaleString()} bytes`);
}

write("standard.zip", standardBackup());
write("not-a-backup.zip", notABackup());
write("large-50mb.zip", largeBackup(50_000_000));
