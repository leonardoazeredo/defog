export interface FileStore {
  list(): Promise<string[]>;
  exists(name: string): Promise<boolean>;
  readText(name: string): Promise<string | null>;
  createText(name: string, text: string): Promise<void>;
  readBytes(name: string): Promise<Uint8Array>;
  readRange(name: string, offset: number, length: number): Promise<Uint8Array>;
  size(name: string): Promise<number>;
  importFrom(sourceUri: string, name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export class FileExistsError extends Error {}
