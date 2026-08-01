import { beforeEach, describe, expect, it, vi } from 'vitest';

const { Client, connect, query, end, warn } = vi.hoisted(() => ({
  Client: class MockClient {
    connect = connect;
    query = query;
    end = end;
  },
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('pg', () => ({ Client }));
vi.mock('../logger', () => ({ logger: { warn } }));

import { withAdvisoryLock } from '../advisory-lock';

beforeEach(() => {
  vi.clearAllMocks();
  connect.mockResolvedValue(undefined);
  query.mockResolvedValue({ rows: [{ locked: true }] });
  end.mockResolvedValue(undefined);
});

describe('PostgreSQL advisory locks', () => {
  it('runs the operation and releases the session lock', async () => {
    const operation = vi.fn().mockResolvedValue('done');

    await expect(withAdvisoryLock(123, operation)).resolves.toBe('done');

    expect(operation).toHaveBeenCalledOnce();
    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_try_advisory_lock($1) AS locked',
      [123],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock($1)',
      [123],
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it('skips the operation when another instance owns the lock', async () => {
    query.mockResolvedValueOnce({ rows: [{ locked: false }] });
    const operation = vi.fn();

    await expect(withAdvisoryLock(456, operation)).resolves.toBeUndefined();

    expect(operation).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it('releases the lock when the operation fails', async () => {
    const error = new Error('task failed');
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withAdvisoryLock(789, operation)).rejects.toBe(error);

    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock($1)',
      [789],
    );
    expect(end).toHaveBeenCalledOnce();
  });
});
