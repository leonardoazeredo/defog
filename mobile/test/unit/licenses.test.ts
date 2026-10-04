import { describe, expect, it } from "vitest";
import { parsePnpmLicenses } from "../../scripts/licenses.js";

const sample = JSON.stringify({
  MIT: [
    { name: "zod", versions: ["4.1.0"], license: "MIT" },
    { name: "expo", versions: ["57.0.1"], license: "MIT" },
  ],
  "0BSD": [{ name: "tslib", versions: ["2.6.0", "2.8.1"], license: "0BSD" }],
});

describe("parsePnpmLicenses", () => {
  it("flattens, splits versions and sorts by name", () =>
    expect(parsePnpmLicenses(sample)).toEqual([
      { name: "expo", version: "57.0.1", license: "MIT" },
      { name: "tslib", version: "2.6.0", license: "0BSD" },
      { name: "tslib", version: "2.8.1", license: "0BSD" },
      { name: "zod", version: "4.1.0", license: "MIT" },
    ]));

  it("rejects output it doesn't recognise", () => expect(() => parsePnpmLicenses("[]")).toThrow());
});
