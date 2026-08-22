import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    factHistory: { create: vi.fn() },
    userFact: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  generateObject: vi.fn(),
  generateText: vi.fn(),
  getPrompt: vi.fn(),
  embedQueryAndPassage: vi.fn(),
  searchSimilarFacts: vi.fn(),
  updateFactEmbedding: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

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

vi.mock('../ai/langfuse', () => ({
  langfuse: { getPrompt: mocks.getPrompt },
}));

vi.mock('../db', () => ({ prisma: mocks.prisma }));
vi.mock('../logger', () => ({ logger: mocks.logger }));

import { analyzeUserMetaInfo } from '../tools/user/fact-analyzer';

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
  mocks.getPrompt.mockResolvedValue({ compile: () => 'system prompt' });
  mocks.embedQueryAndPassage.mockResolvedValue({
    queryEmbedding: [0.1],
    passageEmbedding: [0.2],
  });
  mocks.searchSimilarFacts.mockResolvedValue([]);
  mocks.prisma.userFact.findMany.mockResolvedValue([]);
  mocks.prisma.userFact.create.mockResolvedValue({ id: 100n });
  mocks.prisma.userFact.update.mockResolvedValue({});
  mocks.prisma.factHistory.create.mockResolvedValue({});
  mocks.updateFactEmbedding.mockResolvedValue(undefined);
});

describe('analyzeUserMetaInfo source messages', () => {
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
        sourceChatId: 7n,
        sourceMessageId: 101n,
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
        sourceMessageId: 102n,
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

  it('fills a missing source on a duplicate fact', async () => {
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
      sourceChatId: null,
      sourceMessageId: null,
    });

    await analyzeUserMetaInfo(42n, [createMessage(101n, 'Тот же факт')]);

    expect(mocks.prisma.userFact.update).toHaveBeenCalledWith({
      where: { id: 200n },
      data: {
        weight: 3,
        updatedAt: expect.any(Date),
        sourceChatId: 7n,
        sourceMessageId: 101n,
      },
    });
  });

  it('updates the source when a fact is contradicted', async () => {
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
      sourceChatId: 7n,
      sourceMessageId: 101n,
    });

    await analyzeUserMetaInfo(42n, [
      createMessage(101n, 'Старый факт'),
      createMessage(102n, 'Обновлённый факт'),
    ]);

    expect(mocks.prisma.userFact.update).toHaveBeenCalledWith({
      where: { id: 200n },
      data: {
        content: 'Обновлённый факт',
        weight: 1,
        sourceChatId: 7n,
        sourceMessageId: 102n,
        updatedAt: expect.any(Date),
      },
    });
  });
});
