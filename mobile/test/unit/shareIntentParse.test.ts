import { expect, it, vi } from "vitest";

vi.mock("expo-constants", () => ({ default: { expoConfig: { scheme: "crossfog" } } }));
vi.mock("expo-linking", () => ({ createURL: () => "crossfog://" }));
vi.mock("expo-share-intent/build/useShareIntent.js", () => ({
  SHAREINTENT_DEFAULTVALUE: { files: null, text: null, webUrl: null, type: null, meta: null },
}));

// Each file is the map getFileInfo builds in ExpoShareIntentModule.kt; keep it in step with that
// map. filePath is here so the first test checks that contentUri wins over it.
const androidShare = {
  files: [
    {
      contentUri:
        "content://com.android.externalstorage.documents/document/primary%3ADownload%2Fstandard.zip",
      filePath: "/storage/emulated/0/Download/standard.zip",
      fileName: "standard.zip",
      fileSize: "70316",
      mimeType: "application/zip",
      width: null,
      height: null,
      duration: null,
    },
  ],
  type: "file" as const,
};

it("hands an Android share over as its content URI, which carries the read grant", async () => {
  const { parseShareIntent } = await import("expo-share-intent/build/utils.js");
  const parsed = parseShareIntent(androidShare, {});
  expect(parsed.files?.[0]?.path).toBe(
    "content://com.android.externalstorage.documents/document/primary%3ADownload%2Fstandard.zip",
  );
  expect(parsed.files?.[0]?.fileName).toBe("standard.zip");
});

it("keeps the path of an iOS share, which has no content URI", async () => {
  const { parseShareIntent } = await import("expo-share-intent/build/utils.js");
  // The iOS module sends its share as a JSON string, so parseShareIntent takes its string branch.
  const parsed = parseShareIntent(
    JSON.stringify({
      files: [
        { path: "file:///private/var/mobile/Inbox/standard.zip", mimeType: "application/zip" },
      ],
    }),
    {},
  );
  expect(parsed.files?.[0]?.path).toBe("file:///private/var/mobile/Inbox/standard.zip");
});
