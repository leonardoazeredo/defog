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
        },
      },
      {
        test: {
          name: "adapter",
          environment: "jsdom",
          include: ["test/adapter/**/*.test.ts"],
          passWithNoTests: true,
          setupFiles: ["fake-indexeddb/auto"],
        },
      },
    ],
  },
});
