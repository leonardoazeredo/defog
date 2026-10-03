import { STANDARD_TILE_COUNT, standardBackup } from "../test/fixtures/make-backup.js";
import { runContractCheck } from "./web/contract.js";

const { WEB_HTML } = await import("../../generated/web.js");

const fixture = { zip: standardBackup(), name: "standard.zip", tiles: STANDARD_TILE_COUNT };
const { failures } = await runContractCheck(WEB_HTML, fixture);

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}

console.log("Contract check passed");
