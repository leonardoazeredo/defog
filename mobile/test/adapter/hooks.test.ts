import { beforeEach, expect, it, vi } from "vitest";
import { handleBack } from "../../web-adapter/back.js";
import type { Send } from "../../web-adapter/bridge.js";
import { createSend, onNativeMessage } from "../../web-adapter/bridge.js";
import { installDownloads } from "../../web-adapter/downloads.js";
import { installImportButtons } from "../../web-adapter/importButtons.js";
import { installLinks } from "../../web-adapter/links.js";
import { loadUpstreamDom } from "./support/upstreamDom.js";

const click = (el: Element) => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
};

let sent: unknown[];
let send: Send;
let n: number;

beforeEach(() => {
  const isolated: unknown[] = [];
  sent = isolated;
  send = (m) => isolated.push(m);
  n = 0;
  loadUpstreamDom(document);
  URL.createObjectURL = vi.fn(() => `blob:test/${n++}`);
});

it('"…or a .zip" opens the native picker instead of the WebView\'s chooser', () => {
  installImportButtons(document, send);
  expect(click(document.getElementById("zip")!.closest("label")!).defaultPrevented).toBe(true);
  expect(click(document.getElementById("zip")!).defaultPrevented).toBe(true);
  expect(sent).toEqual([
    { v: 1, type: "pickBackup" },
    { v: 1, type: "pickBackup" },
  ]);
});

it("hides the folder picker", () => {
  installImportButtons(document, send);
  expect(document.getElementById("folder")!.closest("label")!.style.display).toBe("none");
});

it("leaves other clicks alone", () => {
  installImportButtons(document, send);
  expect(click(document.getElementById("tabPlan")!).defaultPrevented).toBe(false);
  expect(sent).toEqual([]);
});

it("window.open sends openExternal and returns null", () => {
  installLinks(window, document, send);
  expect(window.open("https://www.google.com/maps/dir/?api=1", "_blank", "noopener")).toBeNull();
  expect(sent).toEqual([
    { v: 1, type: "openExternal", url: "https://www.google.com/maps/dir/?api=1" },
  ]);
});

it("help links open outside the app", () => {
  installLinks(window, document, send);
  expect(
    click(document.querySelector('a[href="https://drive.google.com"]')!).defaultPrevented,
  ).toBe(true);
  expect(sent).toEqual([{ v: 1, type: "openExternal", url: "https://drive.google.com/" }]);
});

it.each([
  ["fogtomaps-route.gpx", "application/gpx+xml"],
  ["fogtomaps-route.kml", "application/vnd.google-earth.kml+xml"],
])("captures route.js saveBlob for %s", async (filename, mime) => {
  installDownloads(window, document, send);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["<route/>"], { type: mime }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  await vi.waitFor(() =>
    expect(sent).toEqual([{ v: 1, type: "export", filename, mime, text: "<route/>" }]),
  );
});

it("back closes the open sheet and says so", () => {
  const sidebar = document.getElementById("sidebar")!;
  sidebar.classList.add("open");
  expect(handleBack(document)).toBe(true);
  expect(sidebar.classList.contains("open")).toBe(false);
  expect(handleBack(document)).toBe(false);
});

it("handles a message once even when window and document both see it", () => {
  const got: unknown[] = [];
  onNativeMessage(window, document, (m) => got.push(m));
  document.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify({ v: 1, type: "none" }), bubbles: true }),
  );
  expect(got).toEqual([{ v: 1, type: "none" }]);
});

it("drops invalid messages", () => {
  const got: unknown[] = [];
  onNativeMessage(window, document, (m) => got.push(m));
  window.dispatchEvent(new MessageEvent("message", { data: '{"v":1,"type":"selfDestruct"}' }));
  expect(got).toEqual([]);
});

it("message dispatched on window alone reaches the handler", () => {
  const got: unknown[] = [];
  onNativeMessage(window, document, (m) => got.push(m));
  window.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify({ v: 1, type: "none" }), bubbles: false }),
  );
  expect(got).toEqual([{ v: 1, type: "none" }]);
});

it("message dispatched on document alone reaches the handler", () => {
  const got: unknown[] = [];
  onNativeMessage(window, document, (m) => got.push(m));
  document.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify({ v: 1, type: "none" }), bubbles: false }),
  );
  expect(got).toEqual([{ v: 1, type: "none" }]);
});

it("createSend posts through ReactNativeWebView", () => {
  const postMessage = vi.fn();
  const fakeWin = { ReactNativeWebView: { postMessage } } as unknown as Window;
  const send = createSend(fakeWin);
  send({ v: 1, type: "pickBackup" });
  expect(postMessage).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ v: 1, type: "pickBackup" }));
});

it("createSend warns and does nothing when ReactNativeWebView is absent", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fakeWin = {} as unknown as Window;
  const send = createSend(fakeWin);
  send({ v: 1, type: "pickBackup" });
  expect(warn).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith("crossfog: ReactNativeWebView not available");
  warn.mockRestore();
});

it("window.open ignores non-http(s) URLs", () => {
  installLinks(window, document, send);
  expect(window.open("file:///etc/hosts")).toBeNull();
  expect(window.open()).toBeNull();
  expect(sent).toEqual([]);
});

it("window.open sends openExternal for http URLs", () => {
  installLinks(window, document, send);
  window.open("http://example.com");
  expect(sent).toEqual([{ v: 1, type: "openExternal", url: "http://example.com" }]);
});

it("link clicks ignore non-http(s) hrefs", () => {
  const a = document.createElement("a");
  a.setAttribute("href", "javascript:void(0)");
  a.setAttribute("target", "_blank");
  document.body.appendChild(a);
  installLinks(window, document, send);
  click(a);
  expect(sent).toEqual([]);
});

it("link clicks send openExternal for http links", () => {
  const a = document.createElement("a");
  a.setAttribute("href", "http://example.com/path");
  a.setAttribute("target", "_blank");
  document.body.appendChild(a);
  installLinks(window, document, send);
  expect(click(a).defaultPrevented).toBe(true);
  expect(sent).toEqual([{ v: 1, type: "openExternal", url: "http://example.com/path" }]);
});

it("download click on untracked href sends nothing", async () => {
  installDownloads(window, document, send);
  const a = document.createElement("a");
  a.href = "blob:test/not-registered";
  a.download = "file.gpx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  await new Promise((r) => setTimeout(r, 50));
  expect(sent).toEqual([]);
});

it("download click calls preventDefault", async () => {
  installDownloads(window, document, send);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["data"], { type: "text/plain" }));
  a.download = "file.txt";
  document.body.appendChild(a);
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  a.remove();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(ev.defaultPrevented).toBe(true);
});
