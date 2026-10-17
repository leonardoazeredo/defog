import { describe, expect, it } from "vitest";
import { parsePnpmLicenses } from "../../scripts/licenses.js";

const sample = JSON.stringify({
  MIT: [
    { name: "zod", versions: ["4.1.0"], paths: ["/nm/zod"], license: "MIT" },
    { name: "expo", versions: ["57.0.1"], paths: ["/nm/expo"], license: "MIT" },
  ],
  "0BSD": [{ name: "tslib", versions: ["2.6.0", "2.8.1"], paths: ["/nm/tslib"], license: "0BSD" }],
});
const plainManifest = () => ({});

describe("parsePnpmLicenses", () => {
  it("flattens, splits versions and sorts by name", () =>
    expect(parsePnpmLicenses(sample, plainManifest)).toEqual([
      { name: "expo", version: "57.0.1", license: "MIT" },
      { name: "tslib", version: "2.6.0", license: "0BSD" },
      { name: "tslib", version: "2.8.1", license: "0BSD" },
      { name: "zod", version: "4.1.0", license: "MIT" },
    ]));

  it("leaves out builds for one OS, CPU or libc, so the list is the same on every machine", () => {
    const withBuilds = JSON.stringify({
      MIT: [
        { name: "noxcturnal", versions: ["0.1.1"], paths: ["/nm/noxcturnal"], license: "MIT" },
        { name: "nox-darwin-arm64", versions: ["0.1.1"], paths: ["/nm/darwin"], license: "MIT" },
        { name: "nox-linux-x64", versions: ["0.1.1"], paths: ["/nm/linux"], license: "MIT" },
        { name: "nox-musl", versions: ["0.1.1"], paths: ["/nm/musl"], license: "MIT" },
      ],
    });
    const manifests: Record<string, object> = {
      "/nm/noxcturnal": { optionalDependencies: { "nox-darwin-arm64": "0.1.1" } },
      "/nm/darwin": { os: ["darwin"], cpu: ["arm64"] },
      "/nm/linux": { cpu: ["x64"] },
      "/nm/musl": { libc: ["musl"] },
    };
    expect(parsePnpmLicenses(withBuilds, (dir) => manifests[dir] ?? {})).toEqual([
      { name: "noxcturnal", version: "0.1.1", license: "MIT" },
    ]);
  });

  it("rejects output it doesn't recognise", () => {
    expect(() => parsePnpmLicenses("[]", plainManifest)).toThrow();
    const noPath = JSON.stringify({
      MIT: [{ name: "x", versions: ["1.0.0"], paths: [], license: "MIT" }],
    });
    expect(() => parsePnpmLicenses(noPath, plainManifest)).toThrow(/install path for x/);
  });
});
