import { beforeEach, describe, expect, it, vi } from 'vitest';

const { schedule, withAdvisoryLock, reactivateInactiveGroupChatsRepo } =
  vi.hoisted(() => ({
    schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
    withAdvisoryLock: vi.fn(),
    reactivateInactiveGroupChatsRepo: vi.fn(),
  }));

vi.mock('node-cron', () => ({ default: { schedule } }));
vi.mock('../advisory-lock', () => ({
  SCHEDULER_LOCK_KEY: 123,
  withAdvisoryLock,
}));
vi.mock('../analytics', () => ({ sendDailyAnalyticsReport: vi.fn() }));
vi.mock('../bot', () => ({
  bot: { api: { getMe: vi.fn().mockResolvedValue({ id: 999 }) } },
}));
vi.mock('../domain/user/fact-impact-tracker', () => ({
  recalculateFactImpactScores: vi.fn(),
}));
vi.mock('../domain/user/migrate-meta-info', () => ({
  startMetaInfoMigration: vi.fn(),
}));
vi.mock('../features/clean-private-messages', () => ({
  cleanOldPrivateMessages: vi.fn(),
}));
vi.mock('../features/inktober', () => ({ sendInktoberMessage: vi.fn() }));
vi.mock('../features/selfie-saturday', () => ({
  sendSelfieSaturdayMessage: vi.fn(),
}));
vi.mock('../logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../repositories', () => ({
  findManyChatsRepo: vi.fn().mockResolvedValue([]),
  reactivateInactiveGroupChatsRepo,
  updateUserFactsWeightRepo: vi.fn(),
}));

import { startScheduler } from '../scheduler';

beforeEach(() => {
  vi.clearAllMocks();
  schedule.mockReturnValue({ stop: vi.fn() });
  withAdvisoryLock.mockImplementation(
    async (_key: number, task: () => Promise<void>) => task(),
  );
  reactivateInactiveGroupChatsRepo.mockResolvedValue(2);
});

describe('scheduler', () => {
  it('registers daily inactive chat recovery in Moscow under the advisory lock', async () => {
    startScheduler();

    const recovery = schedule.mock.calls.find(
      ([expression]) => expression === '0 1 * * *',
    );
    expect(recovery).toBeDefined();
    expect(recovery?.[2]).toEqual({ timezone: 'Europe/Moscow' });

    await recovery?.[1]();

    expect(withAdvisoryLock).toHaveBeenCalledWith(123, expect.any(Function));
    expect(reactivateInactiveGroupChatsRepo).toHaveBeenCalledOnce();
  });
});
