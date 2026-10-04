import { Asset } from "expo-asset";
import { Alert } from "react-native";
import type { SourceFile } from "../fog/store.js";

export function pickE2eFixture(): Promise<SourceFile | null> {
  return new Promise((resolve) => {
    Alert.alert("Pick fixture", undefined, [
      {
        text: "Standard backup",
        onPress: () =>
          void loadAsset(require("../../assets/e2e/standard.zip"), "standard.zip").then(resolve),
      },
      {
        text: "Not a backup",
        onPress: () =>
          void loadAsset(require("../../assets/e2e/not-a-backup.zip"), "not-a-backup.zip").then(
            resolve,
          ),
      },
      { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
    ]);
  });
}

async function loadAsset(module: number, name: string): Promise<SourceFile> {
  const asset = Asset.fromModule(module);
  await asset.downloadAsync();
  return { uri: asset.localUri ?? asset.uri, name };
}
