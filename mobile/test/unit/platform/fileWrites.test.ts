import { beforeEach, expect, it, vi } from "vitest";

// In-memory expo-file-system 58: File.write() returns a Promise and lands after the call.
const disk = new Map<string, string>();
let failWrites = false;

const join = (...parts: (string | { uri: string })[]) =>
  parts.map((p) => (typeof p === "string" ? p : p.uri).replace(/\/$/, "")).join("/");

vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(...parts);
    }
    get exists() {
      return disk.has(this.uri);
    }
    async write(content: string, options?: { append?: boolean }) {
      // Settles after the call returns, like the real write, so a skipped await reads stale data.
      await new Promise((r) => setTimeout(r, 5));
      if (failWrites) throw new Error("disk full");
      disk.set(this.uri, (options?.append ? (disk.get(this.uri) ?? "") : "") + content);
    }
    async move(dest: File) {
      const content = disk.get(this.uri);
      if (content === undefined) throw new Error(`move: ${this.uri} does not exist`);
      disk.delete(this.uri);
      disk.set(dest.uri, content);
      this.uri = dest.uri;
    }
    async text() {
      return disk.get(this.uri) ?? "";
    }
    delete() {
      disk.delete(this.uri);
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(...parts);
    }
    get exists() {
      return true;
    }
    create() {}
    list() {
      return [...disk.keys()].filter((k) => k.startsWith(`${this.uri}/`)).map((uri) => ({ uri }));
    }
  }
  return { File, Directory, Paths: { document: "doc", cache: "cache" } };
});

const shared: { uri: string; content: string | undefined }[] = [];
vi.mock("expo-sharing", () => ({
  shareAsync: async (uri: string) => {
    shared.push({ uri, content: disk.get(uri) });
  },
}));

beforeEach(() => {
  disk.clear();
  shared.length = 0;
  failWrites = false;
});

it("createText renames the temp file only after its content is written", async () => {
  const { Directory } = await import("expo-file-system");
  const { createExpoFileStore } = await import("../../../src/platform/expoFileStore.js");
  const fs = createExpoFileStore(new Directory("files", "fog"));
  await fs.createText("pending.json", '{"a":1}');
  expect(await fs.readText("pending.json")).toBe('{"a":1}');
  expect(await fs.exists("pending.json.tmp")).toBe(false);
});

it("shareExport hands the share sheet a file that already holds the export", async () => {
  const { shareExport } = await import("../../../src/platform/nativeHandlers.js");
  await shareExport({ filename: "route.gpx", mime: "application/gpx+xml", text: "<gpx/>" });
  expect(shared).toEqual([{ uri: "cache/exports/route.gpx", content: "<gpx/>" }]);
});

it("logCrash swallows a failing write instead of rejecting later", async () => {
  failWrites = true;
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { logCrash } = await import("../../../src/platform/crashLog.js");
    await expect(logCrash(new Error("boom"))).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

it("logCrash appends one line per crash", async () => {
  const { logCrash } = await import("../../../src/platform/crashLog.js");
  await logCrash(new Error("first"));
  await logCrash("second");
  const lines = (disk.get("doc/crash.log") ?? "").trim().split("\n");
  expect(lines.map((l) => l.split("\t")[1])).toEqual(["first", "second"]);
});
