import { parseHTML } from "linkedom";
import { buildCsp, scriptHash } from "./csp.js";

export class BuildError extends Error {}

export function transformIndexHtml(
  html: string,
  readLocal: (relPath: string) => string,
  adapterJs: string,
): string {
  const { document } = parseHTML(html);

  for (const el of document.querySelectorAll("script[data-goatcounter]")) {
    el.remove();
  }

  for (const link of document.querySelectorAll<Element>("link[rel='stylesheet'][href]")) {
    const href = link.getAttribute("href")!;
    if (/^https?:\/\/|^\/\//.test(href)) {
      throw new BuildError(`External stylesheet not allowed: ${href}`);
    }
    const style = document.createElement("style");
    style.textContent = readLocal(href);
    link.replaceWith(style);
  }

  for (const script of document.querySelectorAll<Element>("script[src]")) {
    const src = script.getAttribute("src")!;
    if (/^https?:\/\/|^\/\//.test(src)) {
      throw new BuildError(`External script not allowed: ${src}`);
    }
    const inlined = document.createElement("script");
    inlined.textContent = readLocal(src).replace(/<\/script/g, "<\\/script");
    script.replaceWith(inlined);
  }

  const charset = document.querySelector("meta[charset]");
  const adapterScript = document.createElement("script");
  adapterScript.textContent = adapterJs;

  const allScripts = [...document.querySelectorAll("script")];
  const allHashes = [adapterJs, ...allScripts.map((s) => s.textContent ?? "")].map(scriptHash);
  const cspMeta = document.createElement("meta");
  cspMeta.setAttribute("http-equiv", "Content-Security-Policy");
  cspMeta.setAttribute("content", buildCsp(allHashes));

  if (charset != null) {
    charset.after(cspMeta);
    cspMeta.after(adapterScript);
  } else {
    document.head.prepend(adapterScript);
    document.head.prepend(cspMeta);
  }

  return document.toString();
}
