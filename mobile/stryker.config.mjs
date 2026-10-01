// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "pnpm",
  testRunner: "vitest",
  // Stryker plugin auto-discovery globs node_modules/@stryker-mutator/* but
  // pnpm's non-flat layout makes that unreliable; declare the runner explicitly.
  plugins: ["@stryker-mutator/vitest-runner"],
  reporters: ["progress", "clear-text", "html"],
  coverageAnalysis: "perTest",
  // TypeScript 7 does not expose ts.parseConfigFileTextToJson, so Stryker's
  // tsconfig rewriter crashes when it tries to patch paths for the sandbox.
  // Pointing tsconfigFile at a non-existent file skips that rewrite; the real
  // tsconfig.json still lands in the sandbox and vitest transforms TS via
  // esbuild/oxc without needing it rewritten.
  tsconfigFile: "tsconfig.unused-by-stryker.json",
  mutate: [
    "src/bridge/{protocol,base64,hex,navigationPolicy,exportFile}.ts",
    "src/fog/*.ts",
    "src/import/{incoming,incomingQueue}.ts",
    "src/controller.ts",
    "web-adapter/*.ts",
    "!web-adapter/index.ts",
    "!web-adapter/globals.d.ts",
    "scripts/web/{hostPolicy,hosts,csp,transform}.ts",
  ],
  thresholds: { high: 90, low: 80, break: 80 },
};

export default config;
