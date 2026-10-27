import type { SQLiteDatabase } from "expo-sqlite";

export const THREAD_CACHE_MAX_BYTES = 150 * 1024 * 1024;
export const THREAD_PREFETCH_LIMIT = 50;

export interface ThreadCacheIndexRow {
  readonly threadId: string;
  readonly sourceUpdatedAt: number | null;
  readonly bytes: number;
  readonly accessedAt: number;
}

export interface ThreadCacheBudgetInput {
  readonly maxBytes: number;
  readonly protectedThreadKeys: ReadonlySet<string>;
}

export async function enforceThreadCacheBudget(
  database: SQLiteDatabase,
  input: ThreadCacheBudgetInput,
): Promise<{ evicted: number; bytes: number }> {
  if (!Number.isFinite(input.maxBytes) || input.maxBytes < 0) {
    throw new RangeError("Thread cache budget must be a nonnegative finite number.");
  }
  let evicted = 0;
  let bytes = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const total = await transaction.getFirstAsync<{ readonly bytes: number }>(
      "SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM client_cache_meta WHERE kind = 'thread'",
    );
    bytes = total?.bytes ?? 0;
    if (bytes <= input.maxBytes) return;
    const rows = await transaction.getAllAsync<{
      readonly environmentId: string;
      readonly threadId: string;
      readonly bytes: number;
    }>(`SELECT environment_id AS environmentId, cache_key AS threadId, byte_size AS bytes
        FROM client_cache_meta WHERE kind = 'thread'
        ORDER BY accessed_at, environment_id, cache_key`);
    for (const row of rows) {
      if (bytes <= input.maxBytes) break;
      if (input.protectedThreadKeys.has(`${row.environmentId}:${row.threadId}`)) continue;
      const metadata = await transaction.runAsync(
        "DELETE FROM client_cache_meta WHERE environment_id = ? AND kind = 'thread' AND cache_key = ?",
        row.environmentId,
        row.threadId,
      );
      const result = await transaction.runAsync(
        "DELETE FROM client_cache WHERE environment_id = ? AND kind = 'thread' AND cache_key = ?",
        row.environmentId,
        row.threadId,
      );
      evicted += result.changes;
      bytes -= row.bytes * metadata.changes;
    }
  });
  return { evicted, bytes };
}
