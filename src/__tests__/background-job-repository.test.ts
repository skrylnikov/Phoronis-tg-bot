import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    backgroundJob: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../db', () => ({ prisma }));

import {
  backgroundJobBackoffMs,
  claimNextBackgroundJobRepo,
  enqueueBackgroundJobRepo,
  failBackgroundJobRepo,
  heartbeatBackgroundJobRepo,
} from '../repositories/background-job-repository';

describe('background jobs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps dedupe keys idempotent', async () => {
    prisma.backgroundJob.upsert.mockResolvedValue({});

    await enqueueBackgroundJobRepo({
      type: 'USER_MESSAGE_ANALYSIS',
      dedupeKey: 'analysis:1',
      payload: { userId: 1 },
    });

    expect(prisma.backgroundJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: 'analysis:1' },
        update: {},
      }),
    );
  });

  it('caps retry backoff and claims one job', async () => {
    expect(backgroundJobBackoffMs(1)).toBe(5_000);
    expect(backgroundJobBackoffMs(99)).toBe(30 * 60 * 1000);
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        id: 'job-1',
        type: 'USER_MESSAGE_ANALYSIS',
        dedupeKey: 'analysis:1',
        payload: {},
        attempts: 1,
      },
    ]);

    await expect(
      claimNextBackgroundJobRepo('worker-1', 10_000),
    ).resolves.toMatchObject({ id: 'job-1' });
  });

  it('renews only the owning lease', async () => {
    prisma.backgroundJob.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      heartbeatBackgroundJobRepo('job-1', 'worker-1', 10_000),
    ).resolves.toBe(true);
    expect(prisma.backgroundJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'job-1', workerId: 'worker-1' }),
      }),
    );
  });

  it('moves failed jobs to retry or terminal state', async () => {
    prisma.backgroundJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      failBackgroundJobRepo({
        id: 'job-1',
        workerId: 'worker-1',
        attempts: 1,
        maxAttempts: 3,
        error: 'temporary',
      }),
    ).resolves.toBe('retry');
    expect(prisma.backgroundJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );

    await expect(
      failBackgroundJobRepo({
        id: 'job-1',
        workerId: 'worker-1',
        attempts: 3,
        maxAttempts: 3,
        error: 'permanent',
      }),
    ).resolves.toBe('failed');
    expect(prisma.backgroundJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });
});
