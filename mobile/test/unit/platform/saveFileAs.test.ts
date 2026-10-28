import { beforeEach, describe, expect, it, vi } from "vitest";

const sizes = new Map<string, number>();
let written: number;

vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache", document: "doc" },
  Directory: class {},
  File: class {
    readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get size() {
      return sizes.get(this.uri) ?? 0;
    }
  },
}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("../../../src/platform/watchLinkModule.js", () => ({
  createDocument: async () => "content://docs/b.db",
  copyToUri: async () => written,
  displayNameOf: async () => "b.db",
}));

const { saveFileAs } = await import("../../../src/platform/backupPlatform.js");

beforeEach(() => {
  sizes.clear();
  sizes.set("file:///cache/backup/b.db", 8192);
});

describe("saveFileAs", () => {
  it("names the saved document when every byte was written", async () => {
    written = 8192;
    await expect(saveFileAs("/cache/backup/b.db", "b.db", "x")).resolves.toEqual({ name: "b.db" });
  });

  it("fails when the document got fewer bytes than the file holds", async () => {
    written = 4096;
    await expect(saveFileAs("/cache/backup/b.db", "b.db", "x")).rejects.toThrow(
      "the saved copy is incomplete",
    );
  });
});
