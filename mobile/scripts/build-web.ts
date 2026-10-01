import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleAdapter } from "./web/bundleAdapter.js";
import { scanHosts, unknownHosts } from "./web/hosts.js";
import { BuildError, transformIndexHtml } from "./web/transform.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function buildWebHtml(opts: {
  appDir: string;
  devTools: boolean;
  editIndex?: (html: string) => string;
}): Promise<string> {
  const { appDir, devTools, editIndex } = opts;

  let html = readFileSync(resolve(appDir, "index.html"), "utf-8");
  if (editIndex != null) html = editIndex(html);

  const srcDir = resolve(appDir, "src");
  const srcContents = readdirSync(srcDir).map((f) => readFileSync(resolve(srcDir, f), "utf-8"));
  const allSources = [html, ...srcContents];

  const found = scanHosts(allSources);
  const unknown = unknownHosts(found);
  if (unknown.length > 0) {
    throw new BuildError(
      `Unknown host(s) in app/: ${unknown.join(", ")}. Review them, then add each to scripts/web/hostPolicy.ts.`,
    );
  }

  const adapterJs = await bundleAdapter({ devTools });

  return transformIndexHtml(
    html,
    (relPath) => readFileSync(resolve(appDir, relPath), "utf-8"),
    adapterJs,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const appDir = resolve(ROOT, "app");
  const devTools = process.env.CROSSFOG_E2E === "1";
  const out = await buildWebHtml({ appDir, devTools });
  const outDir = resolve(ROOT, "generated");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "web.ts");
  writeFileSync(outPath, `export const WEB_HTML: string = ${JSON.stringify(out)};\n`);
  const kb = (Buffer.byteLength(out, "utf-8") / 1024).toFixed(1);
  console.log(`generated/web.ts (${kb} KB)`);
}
