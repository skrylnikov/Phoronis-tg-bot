import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lockKeys: {
    dailyAnalytics: 101,
    chatActivityRecovery: 102,
    selfieSaturday: 103,
    inktober: 104,
    factDecay: 105,
    factImpact: 106,
    privateMessageCleanup: 107,
    metaInfoMigration: 108,
  },
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  reactivateInactiveGroupChatsRepo: vi.fn(),
  recalculateFactImpactScores: vi.fn(),
  schedule: vi.fn(),
  startMetaInfoMigration: vi.fn(),
  stopMetaInfoMigration: vi.fn(),
  withAdvisoryLock: vi.fn(),
}));

vi.mock('node-cron', () => ({ default: { schedule: mocks.schedule } }));
vi.mock('../advisory-lock', () => ({
  SCHEDULER_LOCK_KEYS: mocks.lockKeys,
  withAdvisoryLock: mocks.withAdvisoryLock,
}));
vi.mock('../analytics', () => ({ sendDailyAnalyticsReport: vi.fn() }));
vi.mock('../bot', () => ({
  bot: { api: { getMe: vi.fn().mockResolvedValue({ id: 999 }) } },
}));
vi.mock('../domain/user/fact-impact-tracker', () => ({
  recalculateFactImpactScores: mocks.recalculateFactImpactScores,
}));
vi.mock('../domain/user/migrate-meta-info', () => ({
  startMetaInfoMigration: mocks.startMetaInfoMigration,
  stopMetaInfoMigration: mocks.stopMetaInfoMigration,
}));
vi.mock('../features/clean-private-messages', () => ({
  cleanOldPrivateMessages: vi.fn(),
}));
vi.mock('../features/inktober', () => ({ sendInktoberMessage: vi.fn() }));
vi.mock('../features/selfie-saturday', () => ({
  sendSelfieSaturdayMessage: vi.fn(),
}));
vi.mock('../logger', () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    warn: vi.fn(),
  },
}));
vi.mock('../repositories', () => ({
  findManyChatsRepo: vi.fn().mockResolvedValue([]),
  reactivateInactiveGroupChatsRepo: mocks.reactivateInactiveGroupChatsRepo,
  updateUserFactsWeightRepo: vi.fn(),
}));

import { runSchedulerTask, startScheduler, stopScheduler } from '../scheduler';

beforeEach(async () => {
  await stopScheduler();
  vi.clearAllMocks();
  mocks.schedule.mockImplementation(() => ({ stop: vi.fn() }));
  mocks.stopMetaInfoMigration.mockResolvedValue(undefined);
  mocks.withAdvisoryLock.mockImplementation(
    async (_key: number, task: () => Promise<unknown>) => task(),
  );
  mocks.reactivateInactiveGroupChatsRepo.mockResolvedValue(2);
  mocks.recalculateFactImpactScores.mockResolvedValue(undefined);
});

afterEach(async () => {
  await stopScheduler();
});

describe('scheduler', () => {
  it('registers jobs once and uses a distinct lock key per task type', async () => {
    startScheduler();
    startScheduler();

    expect(mocks.schedule).toHaveBeenCalledTimes(7);
    expect(mocks.startMetaInfoMigration).toHaveBeenCalledOnce();
    const recovery = mocks.schedule.mock.calls.find(
      ([expression]) => expression === '0 1 * * *',
    );
    const impact = mocks.schedule.mock.calls.find(
      ([expression]) => expression === '*/30 * * * *',
    );
    expect(recovery?.[2]).toEqual({ timezone: 'Europe/Moscow' });

    recovery?.[1]();
    impact?.[1]();
    await vi.waitFor(() => {
      expect(mocks.reactivateInactiveGroupChatsRepo).toHaveBeenCalledOnce();
      expect(mocks.recalculateFactImpactScores).toHaveBeenCalledOnce();
    });

    expect(mocks.withAdvisoryLock).toHaveBeenCalledWith(
      mocks.lockKeys.chatActivityRecovery,
      expect.any(Function),
    );
    expect(mocks.withAdvisoryLock).toHaveBeenCalledWith(
      mocks.lockKeys.factImpact,
      expect.any(Function),
    );
  });

  it('reports concurrent same-key runs as skipped while another key completes', async () => {
    const activeKeys = new Set<number>();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.withAdvisoryLock.mockImplementation(
      async (key: number, task: () => Promise<unknown>) => {
        if (activeKeys.has(key)) return undefined;
        activeKeys.add(key);
        try {
          return await task();
        } finally {
          activeKeys.delete(key);
        }
      },
    );

    const first = runSchedulerTask(
      'first',
      mocks.lockKeys.factImpact,
      () => firstGate,
    );
    await vi.waitFor(() =>
      expect(activeKeys.has(mocks.lockKeys.factImpact)).toBe(true),
    );
    const same = runSchedulerTask(
      'same',
      mocks.lockKeys.factImpact,
      async () => {},
    );
    const different = runSchedulerTask(
      'different',
      mocks.lockKeys.privateMessageCleanup,
      async () => {},
    );

    await expect(same).resolves.toBe('skipped');
    await expect(different).resolves.toBe('completed');
    releaseFirst?.();
    await expect(first).resolves.toBe('completed');
  });

  it('stops registered jobs and waits for active runs', async () => {
    let releaseImpact: (() => void) | undefined;
    mocks.recalculateFactImpactScores.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseImpact = resolve;
      }),
    );
    startScheduler();
    const tasks = mocks.schedule.mock.results.map(
      ({ value }) => value as { stop: ReturnType<typeof vi.fn> },
    );
    const impact = mocks.schedule.mock.calls.find(
      ([expression]) => expression === '*/30 * * * *',
    );
    impact?.[1]();
    await vi.waitFor(() =>
      expect(mocks.recalculateFactImpactScores).toHaveBeenCalledOnce(),
    );

    let stopped = false;
    const stopping = stopScheduler().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(tasks.every((task) => task.stop.mock.calls.length === 1)).toBe(true);
    expect(mocks.stopMetaInfoMigration).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);

    releaseImpact?.();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('reports task failures without claiming completion', async () => {
    const error = new Error('failed');

    await expect(
      runSchedulerTask('broken', mocks.lockKeys.factDecay, async () => {
        throw error;
      }),
    ).resolves.toBe('failed');

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scheduler.task_failed', err: error }),
      'Scheduled task failed',
    );
    expect(mocks.loggerInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scheduler.task_completed' }),
      expect.anything(),
    );
  });
});
