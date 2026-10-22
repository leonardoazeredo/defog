export type SqlValue = string | number | null | Uint8Array;

/** What a transaction callback gets: the queries only, since a transaction cannot nest or close. */
export interface SqlTx {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
}

export interface SqlDriver extends SqlTx {
  /** Commits when `fn` resolves and rolls back when it throws. Transactions never overlap. */
  transaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T>;
  /**
   * Writes a full copy of this database to `path`. `key` follows SQLCipher: a passphrase is
   * stretched into the key, `x'<hex>'` is a raw key, null writes a plaintext file.
   */
  exportTo(path: string, key: string | null): Promise<void>;
  close(): Promise<void>;
}

/** The file is not a database, or the key does not open it; SQLite cannot tell the two apart. */
export class NotADatabaseError extends Error {
  override name = "NotADatabaseError";
}

/** A backup file on its own connection, attached as schema `backup`: queries name `backup.<table>`. */
export interface AttachedBackup extends SqlTx {
  /** Copies the attached database into a new file at `path`; `key` as in `SqlDriver.exportTo`. */
  exportTo(path: string, key: string | null): Promise<void>;
  close(): Promise<void>;
}

/** Rejects with `NotADatabaseError` when `key` does not open the file. */
export type OpenBackup = (path: string, key: string | null) => Promise<AttachedBackup>;
