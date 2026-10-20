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
  close(): Promise<void>;
}
