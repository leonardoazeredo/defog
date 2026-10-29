import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { WebToNative } from "../../src/bridge/protocol.js";
import { installPageApi } from "../../web-adapter/pageApi.js";
import { parseWebToNative } from "../support/parseWebToNative.js";
import { loadUpstreamDom } from "./support/upstreamDom.js";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../../../app");
const evalApp = (file: string) =>
  (window as unknown as { eval(code: string): void }).eval(readFileSync(`${APP}/${file}`, "utf-8"));

const $ = (id: string) => document.getElementById(id) as HTMLElement;

let sent: WebToNative[];
beforeEach(() => {
  loadUpstreamDom(document);
  delete window.crossfog;
  sent = [];
  evalApp("src/backup.js");
});

function install() {
  return (
    window as unknown as { BackupButtons: { install(o: object): { refresh(): void } } }
  ).BackupButtons.install({ doc: document, win: window });
}

describe("Backup and Restore buttons", () => {
  it("sit in the fog tab below the import row", () => {
    const pane = $("fogPane");
    expect(pane.contains($("backupBtn"))).toBe(true);
    expect(pane.contains($("restoreBtn"))).toBe(true);
    const importRow = $("zip").closest(".row") as HTMLElement;
    expect(importRow.compareDocumentPosition($("backupRow"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("stay hidden where there is no phone app", () => {
    install();
    expect($("backupRow").style.display).toBe("none");
  });

  it("appear once the adapter has installed the page API", () => {
    const { refresh } = install();
    installPageApi(window, (m) => sent.push(m as WebToNative));
    refresh();
    expect($("backupRow").style.display).toBe("");
  });

  it("show on the load event, after the adapter has run", () => {
    install();
    installPageApi(window, (m) => sent.push(m as WebToNative));
    window.dispatchEvent(new Event("load"));
    expect($("backupRow").style.display).toBe("");
  });

  it("send backup and restore to the phone", () => {
    install();
    installPageApi(window, (m) => sent.push(m as WebToNative));
    $("backupBtn").click();
    $("restoreBtn").click();
    expect(sent).toEqual([
      { v: 1, type: "backup" },
      { v: 1, type: "restore" },
    ]);
    for (const m of sent) expect(parseWebToNative(JSON.stringify(m))).toEqual(m);
  });

  it("do nothing without a phone app", () => {
    install();
    expect(() => {
      $("backupBtn").click();
      $("restoreBtn").click();
    }).not.toThrow();
  });
});
