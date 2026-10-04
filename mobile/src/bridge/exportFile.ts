const UTI_MAP: Record<string, string> = {
  ".gpx": "com.topografix.gpx",
  ".kml": "com.google.earth.kml",
};

export function utiFor(filename: string): string | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return undefined;
  return UTI_MAP[filename.slice(dot).toLowerCase()];
}

export function safeExportName(filename: string): string {
  const segments = filename.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? "";
  const safe = last.replace(/[^A-Za-z0-9._-]/g, "_");
  // "export" if nothing remains after stripping dots (e.g. ".." or "dir/")
  if (/^\.+$/.test(safe) || safe === "") return "export";
  return safe;
}
