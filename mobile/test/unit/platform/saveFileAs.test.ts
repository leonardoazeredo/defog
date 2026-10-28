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
let pickedSize: unknown;
vi.mock("expo-document-picker", () => ({
  getDocumentAsync: async () => ({
    canceled: false,
    assets: [{ uri: "content://downloads/b.db", name: "b.db", size: pickedSize }],
  }),
}));
vi.mock("../../../src/platform/watchLinkModule.js", () => ({
  createDocument: async () => "content://docs/b.db",
  copyToUri: async () => written,
  displayNameOf: async () => "b.db",
}));

const { pickRestoreFile, saveFileAs } = await import("../../../src/platform/backupPlatform.js");

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

  it("fails when the document got more bytes than the file holds", async () => {
    written = 16384;
    await expect(saveFileAs("/cache/backup/b.db", "b.db", "x")).rejects.toThrow(
      "the saved copy is incomplete",
    );
  });

  it("fails when the file's own size cannot be read, even if the counts agree", async () => {
    sizes.clear();
    written = 0;
    await expect(saveFileAs("/cache/backup/b.db", "b.db", "x")).rejects.toThrow(
      "the saved copy is incomplete",
    );
  });
});

describe("pickRestoreFile", () => {
  it("passes on a size the provider reports", async () => {
    pickedSize = 8192;
    expect(await pickRestoreFile()).toEqual({
      uri: "content://downloads/b.db",
      name: "b.db",
      size: 8192,
    });
  });

  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, "8192"])(
    "leaves out a size that is no byte count (%s)",
    async (size) => {
      pickedSize = size;
      expect(await pickRestoreFile()).toEqual({ uri: "content://downloads/b.db", name: "b.db" });
    },
  );
});
