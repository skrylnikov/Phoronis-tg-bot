import type { Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';
import { currentUpdateAbortSignal } from '../update-signal';

const mocks = vi.hoisted(() => {
  process.env.QUEUE_LEASE_DURATION_MS = '3000';
  process.env.QUEUE_POLL_INTERVAL_MS = '10';
  return {
    claimNextTelegramUpdateRepo: vi.fn(),
    cleanupTelegramUpdatesRepo: vi.fn(),
    enqueueTelegramUpdateRepo: vi.fn(),
    heartbeatTelegramUpdateRepo: vi.fn(),
    isDuplicatePrismaErrorRepo: vi.fn(),
    markTelegramUpdateCompletedRepo: vi.fn(),
    markTelegramUpdateFailedRepo: vi.fn(),
    releaseTelegramUpdateLeasesRepo: vi.fn(),
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
});

vi.mock('../repositories', () => ({
  claimNextTelegramUpdateRepo: mocks.claimNextTelegramUpdateRepo,
  cleanupTelegramUpdatesRepo: mocks.cleanupTelegramUpdatesRepo,
  enqueueTelegramUpdateRepo: mocks.enqueueTelegramUpdateRepo,
  heartbeatTelegramUpdateRepo: mocks.heartbeatTelegramUpdateRepo,
  isDuplicatePrismaErrorRepo: mocks.isDuplicatePrismaErrorRepo,
  markTelegramUpdateCompletedRepo: mocks.markTelegramUpdateCompletedRepo,
  markTelegramUpdateFailedRepo: mocks.markTelegramUpdateFailedRepo,
  releaseTelegramUpdateLeasesRepo: mocks.releaseTelegramUpdateLeasesRepo,
}));
vi.mock('../logger', () => ({ logger: mocks.logger }));

import { createTelegramUpdateQueue } from '../telegram-update-queue';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.cleanupTelegramUpdatesRepo.mockResolvedValue([0, 0]);
  mocks.claimNextTelegramUpdateRepo.mockResolvedValue(undefined);
  mocks.heartbeatTelegramUpdateRepo.mockResolvedValue(false);
  mocks.releaseTelegramUpdateLeasesRepo.mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Telegram update worker lifecycle', () => {
  it('aborts a long operation after heartbeat loses the lease', async () => {
    const update = {
      updateId: 42n,
      payload: { update_id: 42 },
      partitionKey: 'global',
      lane: 'NORMAL' as const,
      attempts: 1,
      receivedAt: new Date(),
    };
    mocks.claimNextTelegramUpdateRepo.mockResolvedValueOnce(update);
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const bot = {
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async () => {
        startedResolve();
        const signal = currentUpdateAbortSignal();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    } as unknown as Bot<BotContext>;
    const queue = createTelegramUpdateQueue(bot);

    await queue.start();
    await started;
    await vi.advanceTimersByTimeAsync(1_000);
    const stopping = queue.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;

    expect(mocks.heartbeatTelegramUpdateRepo).toHaveBeenCalled();
    expect(mocks.markTelegramUpdateCompletedRepo).not.toHaveBeenCalled();
    expect(mocks.markTelegramUpdateFailedRepo).not.toHaveBeenCalled();
    expect(mocks.releaseTelegramUpdateLeasesRepo).toHaveBeenCalled();
  });
});
