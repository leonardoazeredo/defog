import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
          passWithNoTests: true,
          setupFiles: ["test/setup/stryker-activator.ts"],
          // large Uint8Array toEqual in fixtures.test.ts takes ~5s due to vitest's iterator-based comparison
          testTimeout: 30_000,
        },
      },
      {
        resolve: {
          alias: {
            "@noble/hashes/sha256": fileURLToPath(
              new URL("test/adapter/support/nobleStub.ts", import.meta.url),
            ),
            "@noble/hashes/utils": fileURLToPath(
              new URL("test/adapter/support/nobleStub.ts", import.meta.url),
            ),
          },
        },
        test: {
          name: "adapter",
          environment: "jsdom",
          include: ["test/adapter/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
    ],
  },
});
