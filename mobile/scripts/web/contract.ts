import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { encodeBase64 } from "../../src/bridge/base64.js";
import type { NativeToWeb } from "../../src/bridge/protocol.js";
import { encode, ORIGIN, parseWebToNative } from "../../src/bridge/protocol.js";

const ELEMENTS = ["zip", "folder", "loadStatus", "sidebar", "brandName"];
const GLOBALS = ["FogZip.unzip", "FogParser.FogMap.prototype.addTile"];
const CHUNK_SIZE = 64 * 1024;

export async function runContractCheck(
  html: string,
  fixture: { zip: Uint8Array; name: string; tiles: number },
): Promise<{ failures: string[] }> {
  const failures: string[] = [];
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__contractSent = [] as string[];
      (window as unknown as Record<string, unknown>).__cspBlocked = false;
      (window as unknown as Record<string, unknown>).ReactNativeWebView = {
        postMessage(data: string) {
          ((window as unknown as Record<string, unknown>).__contractSent as string[]).push(data);
        },
      };
      document.addEventListener("securitypolicyviolation", (ev) => {
        const e = ev as unknown as { blockedURI: string };
        if (e.blockedURI.includes("example.com")) {
          (window as unknown as Record<string, unknown>).__cspBlocked = true;
        }
      });
    });

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    const originBase = new URL(ORIGIN).origin;
    const extraUrls: string[] = [];
    await page.route("**", async (route) => {
      const url = route.request().url();
      if (url === ORIGIN) {
        await route.fulfill({ body: html, contentType: "text/html" });
      } else {
        if (url.startsWith(originBase)) extraUrls.push(url);
        await route.abort();
      }
    });

    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });

    for (const id of ELEMENTS) {
      if (!(await page.$(`#${id}`))) failures.push(`missing element #${id}`);
    }

    for (const path of GLOBALS) {
      const exists = await page.evaluate((p: string) => {
        const parts = p.split(".");
        let obj: unknown = window;
        for (const part of parts) {
          if (obj == null) return false;
          obj = (obj as Record<string, unknown>)[part];
        }
        return obj !== undefined;
      }, path);
      if (!exists) failures.push(`missing global ${path}`);
    }

    const waitForType = async (type: string, ms: number) => {
      try {
        await page.waitForFunction(
          (t: string) =>
            ((window as unknown as Record<string, unknown>).__contractSent as string[]).some(
              (m) => {
                try {
                  return (JSON.parse(m) as Record<string, unknown>)?.type === t;
                } catch {
                  return false;
                }
              },
            ),
          type,
          { timeout: ms },
        );
        const raw = await page.evaluate(
          (t: string) =>
            ((window as unknown as Record<string, unknown>).__contractSent as string[]).find(
              (m) => {
                try {
                  return (JSON.parse(m) as Record<string, unknown>)?.type === t;
                } catch {
                  return false;
                }
              },
            ) ?? null,
          type,
        );
        return raw ? parseWebToNative(raw) : null;
      } catch {
        return null;
      }
    };

    const dispatch = (msg: NativeToWeb) =>
      page.evaluate((data: string) => {
        window.dispatchEvent(new MessageEvent("message", { data }));
      }, encode(msg));

    const ready = await waitForType("ready", 10_000);
    if (!ready) {
      failures.push("adapter never sent ready");
    } else {
      const fingerprint = createHash("sha256").update(fixture.zip).digest("hex");
      const total = Math.max(1, Math.ceil(fixture.zip.length / CHUNK_SIZE));

      await dispatch({
        v: 1,
        type: "restore",
        fingerprint,
        name: fixture.name,
        savedAt: new Date().toISOString(),
        size: fixture.zip.length,
        role: "current",
      });

      await waitForType("needBytes", 10_000);

      for (let i = 0; i < total; i++) {
        const slice = fixture.zip.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        await dispatch({
          v: 1,
          type: "chunk",
          fingerprint,
          index: i,
          total,
          data: encodeBase64(slice),
        });
      }

      const loadedMsg = await waitForType("loaded", 30_000);
      if (!loadedMsg || loadedMsg.type !== "loaded") {
        failures.push(`fixture load reported ${JSON.stringify(loadedMsg ?? "nothing")}`);
      } else if (!loadedMsg.ok || loadedMsg.tiles !== fixture.tiles) {
        failures.push(`fixture load reported ${JSON.stringify(loadedMsg)}`);
      }
    }

    await page.evaluate(() => {
      fetch("https://example.com/").catch(() => {});
    });
    await page.waitForTimeout(500);
    const cspBlocked = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__cspBlocked as boolean,
    );
    if (!cspBlocked) failures.push("CSP did not block connect-src");

    for (const url of extraUrls) failures.push(`page requested ${url}`);
    for (const msg of pageErrors) failures.push(`page error: ${msg}`);
  } finally {
    await browser.close();
  }

  return { failures };
}
