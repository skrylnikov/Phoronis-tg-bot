import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../generated/prisma/client';
import type { ClaimedBackgroundJob } from '../repositories/background-job-repository';
import { withUpdateAbortSignal } from '../update-signal';

vi.mock('../bot', () => ({ bot: { botInfo: { id: 999 } } }));
const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  recent: vi.fn(),
  sources: vi.fn(),
  enqueue: vi.fn(),
  freeze: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  analyze: vi.fn(),
}));
vi.mock('../repositories/message-repository', () => ({
  countMessagesRepo: mocks.count,
  findMessagesRepo: mocks.recent,
  findAnalysisSourcesRepo: mocks.sources,
}));
vi.mock('../repositories/background-job-repository', () => ({
  enqueueBackgroundJobRepo: mocks.enqueue,
  freezeAnalysisWindowRepo: mocks.freeze,
}));
vi.mock('../domain/quota-service', () => ({
  reserveQuota: mocks.reserve,
  releaseQuota: mocks.release,
}));
vi.mock('../domain/user/fact-analyzer', () => ({
  analyzeUserMetaInfo: mocks.analyze,
}));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import {
  analyzeUserMessagesForUser,
  nextAnalysisQuotaDay,
  scheduleUserMessageAnalysis,
} from '../application/user-message-analysis';

const input = { userId: 42, chatId: -100, isGroup: true };
const base = {
  id: 1n,
  senderId: 42n,
  chatId: -100n,
  sentAt: new Date('2026-09-01T00:00:00Z'),
  private: false,
  text: 'Привет',
  replyToMessageId: null,
} as Message;
function job(
  payload: ClaimedBackgroundJob['payload'] = {
    userId: '42',
    chatId: '-100',
    isGroup: true,
  },
): ClaimedBackgroundJob {
  return {
    id: 'analysis-1',
    type: 'USER_MESSAGE_ANALYSIS',
    dedupeKey: 'key',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    workerId: 'worker-1',
    payload,
    attempts: 1,
    externalDeliveryId: null,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.count.mockResolvedValue(30);
  mocks.recent.mockResolvedValue([base]);
  mocks.sources.mockImplementation(async (options) =>
    options.senderId ? [base] : [],
  );
  mocks.reserve.mockResolvedValue({ allowed: true });
  mocks.freeze.mockResolvedValue(undefined);
  mocks.analyze.mockResolvedValue([]);
});
describe('durable analysis windows', () => {
  it('anchors new jobs before another 60 messages arrive', async () => {
    await scheduleUserMessageAnalysis(input);
    const queued = mocks.enqueue.mock.calls[0][0];
    expect(queued.payload).toMatchObject({
      windowVersion: 1,
      baseMessageIds: ['1'],
      cutoffAt: queued.createdAt.toISOString(),
    });
    mocks.recent.mockResolvedValue([{ ...base, id: 61n }]);
    await analyzeUserMessagesForUser(input, job(queued.payload));
    expect(mocks.analyze.mock.calls[0][1].map((m: Message) => m.id)).toEqual([
      1n,
    ]);
    expect(mocks.recent).toHaveBeenCalledTimes(1);
  });
  it('freezes legacy sources at original creation before AI under lease', async () => {
    await analyzeUserMessagesForUser(input, job());
    expect(mocks.recent).toHaveBeenCalledWith(
      expect.objectContaining({ sentAt: { lte: job().createdAt } }),
    );
    expect(mocks.freeze).toHaveBeenCalledWith(
      'analysis-1',
      'worker-1',
      expect.objectContaining({
        baseMessageIds: ['1'],
        replyMessageIds: [],
        cutoffAt: job().createdAt.toISOString(),
      }),
    );
    expect(mocks.freeze.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.analyze.mock.invocationCallOrder[0],
    );
  });
  it('keeps incoming source identity and links parent in both source sets', async () => {
    const incoming = {
      ...base,
      id: 2n,
      senderId: 43n,
      text: 'Дима, привет',
      replyToMessageId: 1n,
    };
    mocks.sources.mockImplementation(async (options) =>
      options.senderId ? [base] : [incoming],
    );
    await analyzeUserMessagesForUser(input, job());
    const sources = mocks.analyze.mock.calls[0][3];
    expect(sources.find((m: Message) => m.id === 2n)).toMatchObject({
      senderId: 43n,
      replyToMessage: { id: 1n, senderId: 42n },
    });
    expect(mocks.analyze.mock.calls[0][1]).toHaveLength(1);
  });
  it('skips missing/private sources without quota or replacing them', async () => {
    mocks.sources.mockResolvedValue([]);
    await expect(
      analyzeUserMessagesForUser(
        input,
        job({
          windowVersion: 1,
          cutoffAt: job().createdAt.toISOString(),
          baseMessageIds: ['1'],
          replyMessageIds: [],
        }),
      ),
    ).resolves.toEqual({ outcome: 'skipped_no_sources' });
    expect(mocks.recent).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.analyze).not.toHaveBeenCalled();
  });
  it('defers unavailable quota without AI and returns reservation on errors', async () => {
    mocks.reserve.mockResolvedValueOnce({ allowed: false });
    await expect(
      analyzeUserMessagesForUser(input, job()),
    ).resolves.toMatchObject({
      outcome: 'quota_deferred',
      deferUntil: expect.any(Date),
    });
    expect(mocks.analyze).not.toHaveBeenCalled();
    mocks.analyze.mockRejectedValueOnce(new Error('temporary failure'));
    await expect(analyzeUserMessagesForUser(input, job())).rejects.toThrow(
      'temporary failure',
    );
    expect(mocks.release).toHaveBeenCalledOnce();
    await analyzeUserMessagesForUser(input, job());
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('stops writes after lease loss while sources are loading', async () => {
    const controller = new AbortController();
    mocks.recent.mockImplementation(async () => {
      controller.abort();
      return [base];
    });
    await expect(
      withUpdateAbortSignal(controller.signal, () =>
        analyzeUserMessagesForUser(input, job()),
      ),
    ).rejects.toThrow();
    expect(mocks.freeze).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('skips non-thirtieth messages and resets on Moscow midnight', async () => {
    mocks.count.mockResolvedValue(31);
    await scheduleUserMessageAnalysis(input);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(
      nextAnalysisQuotaDay(new Date('2026-10-04T20:59:59Z')).toISOString(),
    ).toBe('2026-10-04T21:00:00.000Z');
    expect(
      nextAnalysisQuotaDay(new Date('2026-10-04T21:00:00Z')).toISOString(),
    ).toBe('2026-10-05T21:00:00.000Z');
  });
});
