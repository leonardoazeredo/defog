import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findAppIndex(): string {
  // Walk up from this test file to the repo root, where app/ and mobile/ sit
  // side-by-side. The extra levels handle Stryker's .stryker-tmp/ sandbox nesting.
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    dir = resolve(dir, "..");
    const candidate = resolve(dir, "app/index.html");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`app/index.html not found (searched up from ${__dirname})`);
}

const INDEX_HTML = findAppIndex();

export function loadUpstreamDom(doc: Document): void {
  const html = readFileSync(INDEX_HTML, "utf-8");
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch?.[1]) throw new Error("No <body> found in app/index.html");
  const bodyContent = bodyMatch[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  doc.body.innerHTML = bodyContent;
}
