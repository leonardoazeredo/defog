import { strFromU8, strToU8, unzlibSync, zlibSync } from "fflate";

// The GPX is an activity's largest column, so it is kept zlib-deflated at rest. ActivityStore and
// schema migration 2 both write with deflateGpx, and the column carries no format marker, so the
// format is frozen: inflateGpx must read every row either ever wrote. A new codec needs a way to
// tell its rows apart (a tag byte or a new column) and a migration of its own.

export function deflateGpx(gpx: string): Uint8Array {
  return zlibSync(strToU8(gpx));
}

export function inflateGpx(bytes: Uint8Array): string {
  return strFromU8(unzlibSync(bytes));
}
