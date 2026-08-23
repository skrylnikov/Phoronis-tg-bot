import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  countMessagesRepo: vi.fn(),
  findMessagesRepo: vi.fn(),
  enqueueBackgroundJobRepo: vi.fn(),
  reserveQuota: vi.fn(),
  releaseQuota: vi.fn(),
  analyzeUserMetaInfo: vi.fn(),
}));

vi.mock('../repositories/message-repository', () => ({
  countMessagesRepo: mocks.countMessagesRepo,
  findMessagesRepo: mocks.findMessagesRepo,
}));
vi.mock('../repositories/background-job-repository', () => ({
  enqueueBackgroundJobRepo: mocks.enqueueBackgroundJobRepo,
}));
vi.mock('../domain/quota-service', () => ({
  reserveQuota: mocks.reserveQuota,
  releaseQuota: mocks.releaseQuota,
}));
vi.mock('../domain/user/fact-analyzer', () => ({
  analyzeUserMetaInfo: mocks.analyzeUserMetaInfo,
}));
vi.mock('../logger', () => ({
  logger: { debug: vi.fn() },
}));

import {
  analyzeUserMessagesForUser,
  scheduleUserMessageAnalysis,
} from '../application/user-message-analysis';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.countMessagesRepo.mockResolvedValue(30);
  mocks.enqueueBackgroundJobRepo.mockResolvedValue(undefined);
  mocks.reserveQuota.mockResolvedValue({
    allowed: true,
    kind: 'ANALYSIS',
    day: new Date('2026-08-23T00:00:00.000Z'),
  });
  mocks.findMessagesRepo.mockResolvedValue([]);
  mocks.analyzeUserMetaInfo.mockResolvedValue(undefined);
  mocks.releaseQuota.mockResolvedValue(undefined);
});

describe('durable user message analysis', () => {
  it('enqueues only every thirtieth message with a stable dedupe key', async () => {
    await scheduleUserMessageAnalysis({
      userId: 42,
      chatId: -100,
      isGroup: true,
    });

    expect(mocks.enqueueBackgroundJobRepo).toHaveBeenCalledWith({
      type: 'USER_MESSAGE_ANALYSIS',
      dedupeKey: 'user-analysis:-100:42:30',
      payload: { userId: '42', chatId: '-100', isGroup: true },
    });
  });

  it('returns the quota reservation when analysis fails', async () => {
    const reservation = {
      allowed: true,
      kind: 'ANALYSIS' as const,
      day: new Date('2026-08-23T00:00:00.000Z'),
    };
    mocks.reserveQuota.mockResolvedValueOnce(reservation);
    mocks.findMessagesRepo.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(
      analyzeUserMessagesForUser({ userId: 42, chatId: -100, isGroup: true }),
    ).rejects.toThrow('database unavailable');

    expect(mocks.releaseQuota).toHaveBeenCalledWith(reservation);
  });
});
