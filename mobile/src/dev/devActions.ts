import { randomUUID } from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import WatchLink from "../../modules/watch-link";
import { addActivityFromGpx } from "./addActivity.js";

// Reached only through the `require` in WebShell's `devAddActivity`; import it nowhere else.
export function createDevAddActivity(
  handOff: { run(): Promise<unknown> },
  notify: (text: string) => void,
): () => Promise<void> {
  return async () => {
    try {
      await addActivityFromGpx({
        async pick() {
          const result = await DocumentPicker.getDocumentAsync({
            type: ["application/gpx+xml", "*/*"],
            copyToCacheDirectory: true,
            multiple: false,
          });
          const asset = result.canceled ? undefined : result.assets[0];
          return asset ? new File(asset.uri).text() : null;
        },
        async stage(offer) {
          if (!WatchLink.stageForTest) throw new Error("this build cannot stage test offers");
          await WatchLink.stageForTest(JSON.stringify(offer));
        },
        handOff,
        newId: randomUUID,
      });
    } catch (e) {
      // The error name only: a message can quote the track.
      console.warn("crossfog: dev add activity failed", e instanceof Error ? e.name : "unknown");
      notify("Dev: could not add that activity");
    }
  };
}
