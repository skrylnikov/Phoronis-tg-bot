import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    aiThreadContext: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  tx: {
    aiThreadContext: { update: vi.fn() },
    aiThreadContextEvent: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('../db', () => ({ prisma: mocks.prisma }));

import {
  appendAiThreadEventsRepo,
  ensureAiThreadContextRepo,
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
});
