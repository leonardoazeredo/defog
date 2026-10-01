import { beforeEach, expect, it } from "vitest";
import type { SourceFile } from "../../src/fog/store.js";
import {
  acceptIncoming,
  fileFromSystemPath,
  filesFromShareIntent,
  isDisposableCopy,
  nameFromFileUrl,
} from "../../src/import/incoming.js";
import { enqueueIncoming, subscribeIncoming } from "../../src/import/incomingQueue.js";

beforeEach(() => {
  subscribeIncoming(() => {})(); // drain any files left in the queue by the previous test
});

it.each([
  ["Backup.ZIP", true],
  ["fog.zip", true],
  ["fog.Zip", true],
  ["backup.zip.txt", false],
  ["photo.jpg", false],
  ["backup", false],
  ["", false],
])("RF5: acceptIncoming(%j) is %s", (name, ok) => expect(acceptIncoming(name)).toBe(ok));

it("reads names from file URLs", () =>
  expect(
    nameFromFileUrl(
      "file:///var/mobile/Containers/Data/Application/X/Documents/Inbox/My%20Fog.zip",
    ),
  ).toBe("My Fog.zip"));

it("takes only file URLs from the system", () => {
  expect(fileFromSystemPath("file:///x/Inbox/a.zip")).toEqual({
    uri: "file:///x/Inbox/a.zip",
    name: "a.zip",
  });
  expect(fileFromSystemPath("crossfog://about")).toBeNull();
  expect(fileFromSystemPath("/")).toBeNull();
});

it("RF5: accepts files shared as application/octet-stream", () =>
  expect(
    filesFromShareIntent([
      {
        path: "/data/user/0/codes.madera.crossfog/cache/fog.zip",
        fileName: "fog.zip",
        mimeType: "application/octet-stream",
      },
    ]),
  ).toEqual([{ uri: "file:///data/user/0/codes.madera.crossfog/cache/fog.zip", name: "fog.zip" }]));

it("deletes only the app's own temporary copies", () => {
  const roots = {
    cache: "file:///app/Library/Caches/",
    inbox: "file:///app/Documents/Inbox/",
  };
  expect(isDisposableCopy("file:///app/Library/Caches/DocumentPicker/fog.zip", roots)).toBe(true);
  expect(isDisposableCopy("file:///app/Documents/Inbox/fog.zip", roots)).toBe(true);
  expect(isDisposableCopy("file:///app/Documents/fog/abc.zip", roots)).toBe(false);
  expect(isDisposableCopy("file:///storage/emulated/0/Download/fog.zip", roots)).toBe(false);
  expect(isDisposableCopy("content://com.android.providers.downloads/1", roots)).toBe(false);
});

it("replays files queued before the shell subscribed", () => {
  const file: SourceFile = { uri: "file:///x/a.zip", name: "a.zip" };
  enqueueIncoming(file);
  const received: SourceFile[] = [];
  const unsub = subscribeIncoming((f) => received.push(f));
  expect(received).toEqual([file]);
  unsub();
});
