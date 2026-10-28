import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for expo-file-system under a cache root: files by uri, directories implied by their files.
const disk = new Map<string, Uint8Array>();
const CACHE = "file:///data/user/0/app/cache";

const join = (...parts: (string | { uri: string })[]) =>
  parts.map((p) => (typeof p === "string" ? p : p.uri).replace(/\/$/, "")).join("/");
const under = (uri: string) => [...disk.keys()].filter((k) => k.startsWith(`${uri}/`));

vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(...parts);
    }
    get exists() {
      return disk.has(this.uri);
    }
    async write(bytes: Uint8Array) {
      disk.set(this.uri, bytes);
    }
    async bytes() {
      const b = disk.get(this.uri);
      if (b === undefined) throw new Error("missing");
      return b;
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
      return under(this.uri).length > 0;
    }
    create() {}
    delete() {
      for (const k of under(this.uri)) disk.delete(k);
    }
    list() {
      const names = new Set(under(this.uri).map((k) => k.slice(this.uri.length + 1).split("/")[0]));
      return [...names].map((n) => new Directory(this.uri, n as string));
    }
  }
  return { File, Directory, Paths: { cache: { uri: CACHE } } };
});

const { createExportFs } = await import("../../../src/platform/exportFiles.js");

beforeEach(() => disk.clear());

describe("the export flow's cache files", () => {
  it("writes, reads and removes a file by its path under the cache", async () => {
    const fs = createExportFs();
    await fs.write("export-e1/parts/aaaa/0", Uint8Array.of(1, 2));
    expect([...(await fs.read("export-e1/parts/aaaa/0"))]).toEqual([1, 2]);
    await fs.remove("export-e1");
    expect(disk.size).toBe(0);
  });

  it("removes only the export directories of the cache", async () => {
    const fs = createExportFs();
    await fs.write("export-a/Sync/x", Uint8Array.of(1));
    await fs.write("export-b/parts/y/0", Uint8Array.of(2));
    await fs.write("backup/keep", Uint8Array.of(3));
    await fs.write("exports/share.gpx", Uint8Array.of(4));
    await fs.removeExportDirs();
    expect([...disk.keys()]).toEqual([`${CACHE}/backup/keep`, `${CACHE}/exports/share.gpx`]);
  });

  it("refuses a path that could leave the cache or name the cache itself", async () => {
    const fs = createExportFs();
    for (const bad of ["", "/abs", "export-a/../x", "export-a//x", "..", "export-a/./x", "x/"]) {
      await expect(fs.write(bad, Uint8Array.of(1)), bad).rejects.toThrow(/unsafe cache path/);
      await expect(fs.read(bad), bad).rejects.toThrow(/unsafe cache path/);
      await expect(fs.remove(bad), bad).rejects.toThrow(/unsafe cache path/);
      expect(() => fs.absolute(bad), bad).toThrow(/unsafe cache path/);
    }
    expect(disk.size).toBe(0);
  });

  it("gives a plain file system path for a cache path", () => {
    expect(createExportFs().absolute("export-e1/Sync.zip")).toBe(
      "/data/user/0/app/cache/export-e1/Sync.zip",
    );
  });
});
