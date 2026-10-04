import * as DocumentPicker from "expo-document-picker";
import type { SourceFile } from "../fog/store.js";
import shareMime from "./share-mime.json";

export async function pickBackupFile(): Promise<SourceFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: shareMime,
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return { uri: asset.uri, name: asset.name };
}
