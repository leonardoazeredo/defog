import { beforeEach, expect, it, vi } from "vitest";

const disk = new Map<string, string>();

vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    async write(content: string, options?: { append?: boolean }) {
      disk.set(this.uri, (options?.append ? (disk.get(this.uri) ?? "") : "") + content);
    }
  }
  return { File, Paths: { document: "doc" } };
});

beforeEach(() => disk.clear());

it("keeps the numbers that are not positions and replaces the ones that are", async () => {
  const { scrubCoordinates } = await import("../../../src/platform/crashLog.js");
  expect(scrubCoordinates("lat 48.12345, lon 16.3, code 500")).toBe("lat [n], lon 16.3, code 500");
});

it("replaces a negative coordinate including its sign, every one in the message, and a bare fraction", async () => {
  const { scrubCoordinates } = await import("../../../src/platform/crashLog.js");
  expect(scrubCoordinates("gap [-122.4194, 37.7749] to [-122.4100, .001]")).toBe(
    "gap [[n], [n]] to [[n], [n]]",
  );
});

it("replaces a number with exactly three decimals and keeps one with two", async () => {
  const { scrubCoordinates } = await import("../../../src/platform/crashLog.js");
  expect(scrubCoordinates("1.234 and 1.23")).toBe("[n] and 1.23");
});

it("writes the scrubbed message and keeps the timestamp", async () => {
  const { logCrash } = await import("../../../src/platform/crashLog.js");
  await logCrash(new Error("no street near 48.12345,16.54321"));
  const line = disk.get("doc/crash.log") ?? "";
  expect(line).not.toMatch(/48\.12345|16\.54321/);
  const [stamp, message] = line.trimEnd().split("\t");
  expect(message).toBe("no street near [n],[n]");
  expect(stamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

it("scrubs a thrown string as well as an error", async () => {
  const { logCrash } = await import("../../../src/platform/crashLog.js");
  await logCrash("at 51.50735");
  expect(disk.get("doc/crash.log")).toMatch(/\tat \[n\]\n$/);
});
