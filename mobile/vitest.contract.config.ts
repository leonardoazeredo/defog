import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "contract",
    environment: "node",
    include: ["test/contract/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
