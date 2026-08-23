import { describe, expect, it } from 'vitest';
import { readRuntimeConfig } from '../runtime-config';

const validEnv = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' };

describe('runtime config', () => {
  it('requires a PostgreSQL DATABASE_URL', () => {
    expect(() => readRuntimeConfig({})).toThrow('DATABASE_URL not found');
    expect(() =>
      readRuntimeConfig({ DATABASE_URL: 'http://localhost/db' }),
    ).toThrow('DATABASE_URL must be a PostgreSQL URL');
  });

  it('uses safe defaults and validates queue limits', () => {
    const config = readRuntimeConfig(validEnv);
    expect(config.queue.normalWorkers).toBe(3);
    expect(config.job.workers).toBe(1);
    expect(config.shutdownDrainMs).toBe(30_000);
    expect(() =>
      readRuntimeConfig({ ...validEnv, QUEUE_MAX_ATTEMPTS: '0' }),
    ).toThrow('QUEUE_MAX_ATTEMPTS');
  });
});
