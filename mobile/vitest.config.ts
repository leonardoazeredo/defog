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
