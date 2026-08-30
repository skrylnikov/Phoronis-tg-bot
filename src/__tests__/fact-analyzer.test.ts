import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const prisma = {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    factHistory: { create: vi.fn() },
    userFactEvidence: { createMany: vi.fn() },
    userFact: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  return {
    prisma,
    generateObject: vi.fn(),
    generateText: vi.fn(),
    embedQueryAndPassage: vi.fn(),
    searchSimilarFacts: vi.fn(),
    updateFactEmbedding: vi.fn(),
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
});

vi.mock('ai', () => ({
  Output: { object: vi.fn((value) => value) },
  generateObject: mocks.generateObject,
  generateText: mocks.generateText,
}));

vi.mock('../ai/ai', () => ({
  utilityModel: { modelId: 'qwen/qwen3.7-flash' },
}));

vi.mock('../ai/embedding/client', () => ({
  embedQueryAndPassage: mocks.embedQueryAndPassage,
}));

vi.mock('../ai/embedding/store', () => ({
  searchSimilarFacts: mocks.searchSimilarFacts,
  updateFactEmbedding: mocks.updateFactEmbedding,
}));

vi.mock('../db', () => ({ prisma: mocks.prisma }));
vi.mock('../logger', () => ({ logger: mocks.logger }));

import {
  analyzeUserMetaInfo,
  getTopUserFacts,
} from '../domain/user/fact-analyzer';

function createMessage(id: bigint, text: string) {
  return {
    id,
    chatId: 7n,
    senderId: 42n,
    messageType: 'TEXT',
    text,
    summary: null,
    media: null,
    searchText: null,
    embeddingVersion: null,
    sentAt: new Date('2026-08-01T00:00:00.000Z'),
    private: false,
    replyToMessage: null,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.embedQueryAndPassage.mockResolvedValue({
    queryEmbedding: [0.1],
    passageEmbedding: [0.2],
  });
  mocks.searchSimilarFacts.mockResolvedValue([]);
  mocks.prisma.userFact.findMany.mockResolvedValue([]);
  mocks.prisma.userFact.create.mockResolvedValue({ id: 100n });
  mocks.prisma.userFact.update.mockResolvedValue({});
  mocks.prisma.userFactEvidence.createMany.mockResolvedValue({ count: 1 });
  mocks.prisma.factHistory.create.mockResolvedValue({});
  mocks.updateFactEmbedding.mockResolvedValue(undefined);
});

describe('analyzeUserMetaInfo source messages', () => {
  it('propagates analysis failures to the durable job runner', async () => {
    const error = new Error('model unavailable');
    mocks.generateObject.mockRejectedValue(error);

    await expect(
      analyzeUserMetaInfo(42n, [createMessage(101n, 'Сообщение')]),
    ).rejects.toThrow('model unavailable');

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user_fact.analysis_failed',
        err: error,
      }),
      expect.any(String),
    );
  });

  it.each(['embedding', 'search', 'model'] as const)(
    'keeps %s similarity failures retryable',
    async (stage) => {
      const error = new Error(`${stage} unavailable`);
      mocks.generateObject.mockResolvedValue({
        object: {
          facts: [
            {
              content: 'Проверяемый факт',
              type: 'FACT',
              sourceMessageId: '101',
            },
          ],
        },
      });
      if (stage === 'embedding') {
        mocks.embedQueryAndPassage.mockRejectedValue(error);
      } else {
        mocks.searchSimilarFacts.mockResolvedValue([
          { id: 200n, content: 'Похожий факт', similarity: 0.95 },
        ]);
        if (stage === 'search')
          mocks.searchSimilarFacts.mockRejectedValue(error);
        if (stage === 'model') mocks.generateText.mockRejectedValue(error);
      }

      await expect(
        analyzeUserMetaInfo(42n, [createMessage(101n, 'Проверяемый факт')]),
      ).rejects.toThrow(`${stage} unavailable`);

      expect(mocks.prisma.userFact.create).not.toHaveBeenCalled();
    },
  );

  it('saves a valid model-selected source message and includes IDs in the prompt', async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          {
            content: 'Пользователь любит Rust',
            type: 'INTEREST',
            sourceMessageId: '101',
          },
        ],
      },
    });

    await analyzeUserMetaInfo(42n, [
      createMessage(101n, 'Я люблю Rust'),
      createMessage(102n, 'И пишу на нём сервисы'),
    ]);

    expect(mocks.generateObject.mock.calls[0]?.[0].prompt).toContain(
      '[MESSAGE_ID: 101]',
    );
    expect(mocks.prisma.userFact.create).toHaveBeenCalledWith({
      data: {
        userId: 42n,
        content: 'Пользователь любит Rust',
        type: 'INTEREST',
        weight: 1,
        evidence: {
          create: { sourceChatId: 7n, sourceMessageId: 101n },
        },
      },
    });
  });

  it('skips only facts with an unknown source message ID', async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          {
            content: 'Неверный факт',
            type: 'FACT',
            sourceMessageId: 'not-a-message-id',
          },
          {
            content: 'Подтверждённый факт',
            type: 'FACT',
            sourceMessageId: '102',
          },
        ],
      },
    });

    const savedFactIds = await analyzeUserMetaInfo(42n, [
      createMessage(101n, 'Сообщение один'),
      createMessage(102n, 'Сообщение два'),
    ]);

    expect(savedFactIds).toEqual([100n]);
    expect(mocks.prisma.userFact.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.userFact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: 'Подтверждённый факт',
        evidence: {
          create: { sourceChatId: 7n, sourceMessageId: 102n },
        },
      }),
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user_fact.invalid_source_message',
        sourceMessageId: 'not-a-message-id',
      }),
      expect.any(String),
    );
  });

  it('adds evidence without writing legacy source fields', async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          { content: 'Тот же факт', type: 'FACT', sourceMessageId: '101' },
        ],
      },
    });
    mocks.searchSimilarFacts.mockResolvedValue([
      { id: 200n, content: 'Тот же факт', similarity: 0.95 },
    ]);
    mocks.generateText.mockResolvedValue({
      output: {
        duplicateId: '200',
        contradictionId: null,
        reason: 'duplicate',
      },
    });
    mocks.prisma.userFact.findUnique.mockResolvedValue({
      id: 200n,
      content: 'Тот же факт',
      weight: 2,
    });
    mocks.prisma.userFact.findUniqueOrThrow.mockResolvedValue({
      id: 200n,
      content: 'Тот же факт',
      weight: 2,
    });

    await analyzeUserMetaInfo(42n, [createMessage(101n, 'Тот же факт')]);

    expect(mocks.prisma.userFact.update).toHaveBeenCalledWith({
      where: { id: 200n },
      data: {
        weight: { increment: 1 },
        updatedAt: expect.any(Date),
      },
    });
  });

  it('does not increase a fact twice for the same source message', async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          { content: 'Тот же факт', type: 'FACT', sourceMessageId: '101' },
        ],
      },
    });
    mocks.searchSimilarFacts.mockResolvedValue([
      { id: 200n, content: 'Тот же факт', similarity: 0.95 },
    ]);
    mocks.generateText.mockResolvedValue({
      output: {
        duplicateId: '200',
        contradictionId: null,
        reason: 'duplicate',
      },
    });
    mocks.prisma.userFact.findUnique.mockResolvedValue({
      id: 200n,
      content: 'Тот же факт',
      weight: 2,
    });
    mocks.prisma.userFact.findUniqueOrThrow.mockResolvedValue({
      id: 200n,
      content: 'Тот же факт',
      weight: 2,
    });
    mocks.prisma.userFactEvidence.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const messages = [createMessage(101n, 'Тот же факт')];
    const savedFactIds = await analyzeUserMetaInfo(42n, messages);
    await analyzeUserMetaInfo(42n, messages);

    expect(savedFactIds).toEqual([200n]);
    expect(mocks.prisma.userFact.update).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.userFact.update).toHaveBeenCalledWith({
      where: { id: 200n },
      data: {
        weight: { increment: 1 },
        updatedAt: expect.any(Date),
      },
    });
    expect(mocks.prisma.factHistory.create).toHaveBeenCalledTimes(1);
  });

  it('updates a contradicted fact with new evidence', async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          {
            content: 'Обновлённый факт',
            type: 'FACT',
            sourceMessageId: '102',
          },
        ],
      },
    });
    mocks.searchSimilarFacts.mockResolvedValue([
      { id: 200n, content: 'Старый факт', similarity: 0.95 },
    ]);
    mocks.generateText.mockResolvedValue({
      output: { duplicateId: null, contradictionId: '200', reason: 'changed' },
    });
    mocks.prisma.userFact.findUnique.mockResolvedValue({
      id: 200n,
      content: 'Старый факт',
      weight: 2,
    });
    mocks.prisma.userFact.findUniqueOrThrow.mockResolvedValue({
      id: 200n,
      content: 'Старый факт',
      weight: 2,
    });

    await analyzeUserMetaInfo(42n, [
      createMessage(101n, 'Старый факт'),
      createMessage(102n, 'Обновлённый факт'),
    ]);

    expect(mocks.prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('ranks facts by expiry, type, weight, confidence, and freshness', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.prisma.userFact.findMany.mockResolvedValue([
      {
        content: 'expires',
        type: 'FACT',
        weight: 1,
        confidence: 0,
        updatedAt: now,
        expiresAt: new Date('2026-09-01T12:00:00.000Z'),
      },
      {
        content: 'interest',
        type: 'INTEREST',
        weight: 2,
        confidence: 1,
        updatedAt: new Date('2026-08-26T12:00:00.000Z'),
        expiresAt: null,
      },
      {
        content: 'weight',
        type: 'FACT',
        weight: 4,
        confidence: 0.8,
        updatedAt: new Date('2026-08-30T12:00:00.000Z'),
        expiresAt: null,
      },
      {
        content: 'fresh',
        type: 'FACT',
        weight: 2,
        confidence: 0.5,
        updatedAt: now,
        expiresAt: null,
      },
      {
        content: 'stale',
        type: 'FACT',
        weight: 2,
        confidence: 0.5,
        updatedAt: new Date('2026-08-21T12:00:00.000Z'),
        expiresAt: null,
      },
    ]);

    await expect(getTopUserFacts(42n)).resolves.toEqual([
      expect.objectContaining({ content: 'expires' }),
      expect.objectContaining({ content: 'interest' }),
      expect.objectContaining({ content: 'weight' }),
      expect.objectContaining({ content: 'fresh' }),
      expect.objectContaining({ content: 'stale' }),
    ]);
    vi.useRealTimers();
  });
});
