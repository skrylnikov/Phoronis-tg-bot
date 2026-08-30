import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    aiThreadContext: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    aiThreadContextEvent: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  tx: {
    aiThreadContext: { update: vi.fn() },
    aiThreadContextEvent: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../db', () => ({ prisma: mocks.prisma }));

import {
  appendAiThreadEventsRepo,
  commitAiThreadCacheBoundaryRepo,
  ensureAiThreadContextRepo,
  getAiThreadContextRepo,
} from '../repositories/ai-thread-context-repository';

describe('AI thread context repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(async (callback) =>
      callback(mocks.tx),
    );
    mocks.tx.aiThreadContextEvent.findMany.mockResolvedValue([]);
    mocks.tx.aiThreadContextEvent.findFirst.mockResolvedValue({ sequence: 4 });
    mocks.tx.aiThreadContextEvent.create.mockImplementation(
      async (input) => input.data,
    );
    mocks.tx.aiThreadContext.update.mockResolvedValue({});
    mocks.tx.aiThreadContextEvent.deleteMany.mockResolvedValue({ count: 0 });
  });

  it('assigns monotonic sequence and skips duplicate turn events', async () => {
    mocks.tx.aiThreadContextEvent.findMany.mockResolvedValue([
      { turnId: 'turn-1', eventKind: 'RETRIEVAL' },
    ]);

    const result = await appendAiThreadEventsRepo('thread-1', [
      { turnId: 'turn-1', eventKind: 'RETRIEVAL', payload: { old: true } },
      { turnId: 'turn-2', eventKind: 'USER_MESSAGE', payload: { text: 'new' } },
    ]);

    expect(result).toHaveLength(1);
    expect(mocks.tx.aiThreadContextEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: 'thread-1',
        sequence: 5,
        turnId: 'turn-2',
        eventKind: 'USER_MESSAGE',
      }),
    });
  });

  it('returns the concurrently created settings snapshot', async () => {
    const settings = { id: 'thread-1', rules: ['- Отвечай кратко'] };
    mocks.prisma.aiThreadContext.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(settings);
    mocks.prisma.aiThreadContext.create.mockRejectedValueOnce({
      code: 'P2002',
    });

    await expect(
      ensureAiThreadContextRepo({
        id: 'thread-1',
        chatId: 1n,
        promptVersion: 3,
        promptHash: 'hash',
        rules: ['- Отвечай кратко'],
      }),
    ).resolves.toBe(settings);
  });

  it('reads only the latest confirmed boundary and its tail', async () => {
    mocks.prisma.aiThreadContext.findUnique.mockResolvedValue({
      id: 'thread-1',
      cacheBoundary: 1,
    });
    mocks.prisma.aiThreadContextEvent.findFirst.mockResolvedValue({
      sequence: 5,
    });
    mocks.prisma.aiThreadContextEvent.findMany.mockResolvedValue([
      { sequence: 5, eventKind: 'CACHE_BOUNDARY' },
      { sequence: 6, eventKind: 'USER_MESSAGE' },
    ]);

    const result = await getAiThreadContextRepo('thread-1');

    expect(mocks.prisma.aiThreadContext.findUnique).toHaveBeenCalledWith({
      where: { id: 'thread-1' },
    });
    expect(mocks.prisma.aiThreadContextEvent.findMany).toHaveBeenCalledWith({
      where: {
        threadId: 'thread-1',
        sequence: { gte: 5 },
        OR: [{ messageId: null }, { message: { is: { private: false } } }],
      },
      orderBy: { sequence: 'asc' },
    });
    expect(result?.events.map((event) => event.sequence)).toEqual([5, 6]);
  });

  it('includes only the current private message on an explicit current-turn read', async () => {
    mocks.prisma.aiThreadContext.findUnique.mockResolvedValue({
      id: 'thread-1',
      cacheBoundary: 0,
    });
    mocks.prisma.aiThreadContextEvent.findFirst.mockResolvedValue(null);
    mocks.prisma.aiThreadContextEvent.findMany.mockResolvedValue([]);

    await getAiThreadContextRepo('thread-1', {
      chatId: 100n,
      messageId: 41n,
    });

    expect(mocks.prisma.aiThreadContextEvent.findMany).toHaveBeenCalledWith({
      where: {
        threadId: 'thread-1',
        OR: [
          { messageId: null },
          { message: { is: { private: false } } },
          { messageChatId: 100n, messageId: 41n },
        ],
      },
      orderBy: { sequence: 'asc' },
    });
  });

  it('commits boundary and pruning in one transaction', async () => {
    mocks.tx.aiThreadContextEvent.findFirst.mockResolvedValue({ sequence: 4 });
    mocks.tx.aiThreadContextEvent.create.mockResolvedValue({ sequence: 5 });

    await commitAiThreadCacheBoundaryRepo('thread-1', 1, 4, {
      summary: 'snapshot',
    });

    expect(mocks.tx.aiThreadContextEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sequence: 5,
        eventKind: 'CACHE_BOUNDARY',
      }),
    });
    expect(mocks.tx.aiThreadContextEvent.deleteMany).toHaveBeenCalledWith({
      where: { threadId: 'thread-1', sequence: { lt: 5 } },
    });
  });

  it('keeps a concurrent tail by refusing a stale compaction', async () => {
    mocks.tx.aiThreadContextEvent.findFirst.mockResolvedValue({ sequence: 5 });

    await expect(
      commitAiThreadCacheBoundaryRepo('thread-1', 1, 4, {
        summary: 'stale snapshot',
      }),
    ).rejects.toThrow('AI thread changed during compaction');

    expect(mocks.tx.aiThreadContextEvent.create).not.toHaveBeenCalled();
    expect(mocks.tx.aiThreadContextEvent.deleteMany).not.toHaveBeenCalled();
  });
});
