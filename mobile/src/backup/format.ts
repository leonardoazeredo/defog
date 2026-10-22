import type { AttachedBackup } from "../db/driver.js";
import { SCHEMA_VERSION } from "../db/schema.js";

export const BLOB_IMPORT = "import";
export const BLOB_SETTINGS = "page_settings";
export const SETTINGS_BLOB_NAME = "f2m";

export const BACKUP_MIME = "application/octet-stream";

// SQLCipher files are whole pages, so one that is not a multiple of the smallest page size is no backup.
const PAGE_BYTES = 512;
const PLAIN_HEADER_HEX = "53514c69746520666f726d6174203300";

export function backupName(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `crossfog-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.db`;
}

export type BackupFileKind = "plain" | "maybeEncrypted" | "notABackup";

/** From the first 16 bytes (hex) and the size: a plain SQLite file, a file that may be encrypted, or neither. */
export function classifyBackupFile(headHex: string, size: number): BackupFileKind {
  if (headHex === PLAIN_HEADER_HEX) return "plain";
  if (size < PAGE_BYTES || size % PAGE_BYTES !== 0) return "notABackup";
  return "maybeEncrypted";
}

/** True when the attached file has this app's tables and a schema this build can read. */
export async function isBackupDatabase(db: AttachedBackup): Promise<boolean> {
  const [v] = await db.all<{ user_version: number }>("PRAGMA backup.user_version");
  const version = v?.user_version ?? 0;
  if (version < 1 || version > SCHEMA_VERSION) return false;
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM backup.sqlite_master WHERE type = 'table'",
  );
  const names = new Set(tables.map((t) => t.name));
  return ["activities", "routes", "blobs"].every((n) => names.has(n));
}
