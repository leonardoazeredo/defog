import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// WebShell cannot be rendered in a unit test, so this pins the lines that join the WebView's
// messages to createWebMessageHandler; the handler's own behaviour is in webMessage.test.ts.
it("WebShell gives the WebView's onMessage to createWebMessageHandler", () => {
  const src = readFileSync(new URL("../../../src/WebShell.tsx", import.meta.url), "utf-8");
  expect(src).toMatch(/createWebMessageHandler\(\{[^}]*onMessage: controller\.onWebMessage/s);
  expect(src).toMatch(/abandonExport: \(id\) => void exportFlow\.abandon\(id\)/);
  expect(src).toMatch(/onMessage=\{\(event\) => onWebMessage\(event\.nativeEvent\)\}/);
  expect(src).not.toMatch(/inspectWebToNative|reportDropped/);
});
