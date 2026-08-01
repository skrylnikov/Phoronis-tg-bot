import { Client } from 'pg';
import { logger } from './logger';

export const SCHEDULER_LOCK_KEY = 0x5048_0001;
export const EMBEDDING_BACKFILL_LOCK_KEY = 0x5048_0002;

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
          { error, key },
          'Failed to release PostgreSQL advisory lock',
        );
      }
    }

    if (connected) {
      try {
        await client.end();
      } catch (error) {
        logger.warn({ error, key }, 'Failed to close advisory lock connection');
      }
    }
  }
}
