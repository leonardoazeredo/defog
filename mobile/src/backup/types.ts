import type { PassphraseAnswer } from "../ui/passphraseForm.js";

export type { PassphraseAnswer };

/** Temporary files for a backup or restore, in the cache directory; every one is removed when its flow ends. */
export interface Scratch {
  /** A file system path (no scheme) for a file called `name`. */
  path(name: string): string;
  /** The same file as a URI, for the APIs that take one. */
  uri(path: string): string;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  freeBytes(): Promise<number>;
  databaseBytes(): Promise<number>;
}

export type BackupErrorCode = "noSpace" | "noSettings";

export class BackupError extends Error {
  override name = "BackupError";
  constructor(readonly code: BackupErrorCode) {
    super(code);
  }
}
