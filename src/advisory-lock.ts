import { Client } from 'pg';
import { logger } from './logger';

export const EMBEDDING_BACKFILL_LOCK_KEY = 0x5048_0002;
export const SCHEDULER_LOCK_KEYS = {
  dailyAnalytics: 0x5048_0101,
  chatActivityRecovery: 0x5048_0102,
  selfieSaturday: 0x5048_0103,
  inktober: 0x5048_0104,
  factDecay: 0x5048_0105,
  factImpact: 0x5048_0106,
  privateMessageCleanup: 0x5048_0107,
  metaInfoMigration: 0x5048_0108,
} as const;

type AdvisoryLockKey = number | bigint;

/**
 * Executes an operation while holding a PostgreSQL session advisory lock.
 * Returning undefined means another bot instance currently owns the lock.
 */
export async function withAdvisoryLock<T>(
  key: AdvisoryLockKey,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  let connected = false;
  let locked = false;

  try {
    await client.connect();
    connected = true;

    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key],
    );
    locked = result.rows[0]?.locked === true;

    if (!locked) {
      return undefined;
    }

    return await operation();
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [key]);
      } catch (error) {
        logger.warn(
          { event: 'advisory_lock.release_failed', err: error, key },
          'Failed to release PostgreSQL advisory lock',
        );
      }
    }

    if (connected) {
      try {
        await client.end();
      } catch (error) {
        logger.warn(
          { event: 'advisory_lock.close_failed', err: error, key },
          'Failed to close advisory lock connection',
        );
      }
    }
  }
}
