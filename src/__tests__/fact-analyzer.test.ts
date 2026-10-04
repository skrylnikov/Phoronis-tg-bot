vi.mock('../config', () => ({ embeddingVersion: 1 }));
vi.mock('../advisory-lock', () => ({
  withAdvisoryLock: async (_key: unknown, callback: () => Promise<unknown>) =>
    callback(),
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionQuestion } from '../ai/jev';
import type { Message } from '../generated/prisma/client';

const mocks = vi.hoisted(() => {
  const prisma = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    message: { findUnique: vi.fn() },
    $transaction: vi.fn(),
    factHistory: { create: vi.fn() },
    userFactEvidence: { createMany: vi.fn(), findMany: vi.fn() },
    userFact: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  return {
    prisma,
    generateObject: vi.fn(),
    evaluateJev: vi.fn(),
    createReview: vi.fn(),
    finishReview: vi.fn(),
    relation: 'independent',
    relationProbability: 0.99,
    support: {} as Record<string, number>,
    saveAlias: vi.fn(),
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
  generateObject: mocks.generateObject,
}));

vi.mock('../ai/jev', () => ({ evaluateJev: mocks.evaluateJev }));
vi.mock('../repositories/decision-review-repository', () => ({
  createDecisionReviewRepo: mocks.createReview,
  finishDecisionReviewRepo: mocks.finishReview,
}));

vi.mock('../ai/ai', () => ({
  utilityModel: { modelId: 'openai/gpt-6-luna' },
}));

vi.mock('../ai/embedding/client', () => ({
  embedQueryAndPassage: mocks.embedQueryAndPassage,
}));

vi.mock('../ai/embedding/store', () => ({
  searchSimilarFacts: mocks.searchSimilarFacts,
  updateFactEmbedding: mocks.updateFactEmbedding,
}));

vi.mock('../db', () => ({ prisma: mocks.prisma }));
vi.mock('../repositories/user-alias-repository', () => ({
  saveUserAliasEvidenceRepo: mocks.saveAlias,
}));
vi.mock('../logger', () => ({ logger: mocks.logger }));

import {
  analyzeUserMetaInfo,
  getTopUserFacts,
} from '../domain/user/fact-analyzer';

function createMessage(
  id: bigint,
  text: string,
): Message & { replyToMessage: Message | null } {
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
    sessionId: null,
    modelId: null,
    replyToMessageId: null,
    sentAt: new Date('2026-08-01T00:00:00.000Z'),
    private: false,
    replyToMessage: null,
  };
}

function jevResult(
  _state: object,
  questions: Record<string, DecisionQuestion>,
) {
  return {
    model: 'typesafe/jev-1.13-snapshot',
    durationMs: 123,
    answers: Object.fromEntries(
      Object.entries(questions).map(([key, question]) => [
        key,
        question.type === 'noul'
          ? { type: 'noul', noul: mocks.support[key] ?? 0.99 }
          : {
              type: 'choice',
              choice: mocks.relation,
              confidence: 0.98,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((option) => [
                  option,
                  option === mocks.relation
                    ? mocks.relationProbability
                    : (1 - mocks.relationProbability) / 3,
                ]),
              ),
            },
      ]),
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.support = {};
  mocks.relation = 'independent';
  mocks.relationProbability = 0.99;
  mocks.evaluateJev.mockReset().mockImplementation(jevResult);
  mocks.createReview.mockReset().mockResolvedValue('review-1');
  mocks.finishReview.mockResolvedValue(undefined);
  mocks.embedQueryAndPassage.mockResolvedValue({
    queryEmbedding: [0.1],
    passageEmbedding: [0.2],
  });
  mocks.searchSimilarFacts.mockResolvedValue([]);
  mocks.prisma.userFact.findMany.mockResolvedValue([]);
  mocks.prisma.userFact.findFirst.mockResolvedValue(null);
  mocks.prisma.message.findUnique.mockResolvedValue(
    createMessage(1000n, 'public'),
  );
  mocks.prisma.userFactEvidence.findMany.mockResolvedValue([
    { sourceMessage: createMessage(1n, 'public') },
  ]);
  mocks.prisma.userFact.create.mockResolvedValue({ id: 100n });
  mocks.prisma.userFact.update.mockResolvedValue({});
  mocks.prisma.userFactEvidence.createMany.mockResolvedValue({ count: 1 });
  mocks.prisma.factHistory.create.mockResolvedValue({});
  mocks.updateFactEmbedding.mockResolvedValue(undefined);
});

describe('analyzeUserMetaInfo source messages', () => {
  it('does not echo malformed model source IDs into diagnostic logs', async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          {
            content: 'SENTINEL SOURCE TEXT',
            type: 'FACT',
            sourceMessageId: 'SENTINEL SECRET PROMPT',
          },
        ],
        aliases: [],
      },
    });
    await analyzeUserMetaInfo(42n, [createMessage(101n, 'public')], 999n);
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
      'SENTINEL',
    );
    expect(mocks.prisma.userFact.create).not.toHaveBeenCalled();
  });

  it.each([0.799, 0.8, 0.83])(
    'verifies incoming alias support at %s while keeping reply facts out of the owner map',
    async (support) => {
      mocks.support.alias_0 = support;
      mocks.support.alias_0_addressing = 0.88;
      const base = createMessage(101n, 'Привет');
      const incoming = {
        ...createMessage(102n, 'Дима, привет'),
        senderId: 43n,
        replyToMessageId: base.id,
        replyToMessage: base,
      };
      mocks.generateObject.mockResolvedValue({
        object: {
          facts: [
            { content: 'Живёт в Казани', type: 'FACT', sourceMessageId: '102' },
          ],
          aliases: [
            {
              userId: '42',
              alias: 'Дима',
              confidence: 0.9,
              sourceMessageId: '102',
              neutralForAddressing: true,
            },
          ],
        },
      });
      await analyzeUserMetaInfo(42n, [base], 999n, [base, incoming]);
      expect(mocks.prisma.userFact.create).not.toHaveBeenCalled();
      if (support >= 0.8) {
        expect(mocks.saveAlias).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 42n,
            sourceMessageId: 102n,
            modelConfidence: support,
            neutralForAddressing: true,
          }),
        );
      } else {
        expect(mocks.saveAlias).not.toHaveBeenCalled();
      }
      expect(
        mocks.evaluateJev.mock.calls[0][0].items.alias_0.source,
      ).toMatchObject({
        authorId: '43',
        messageId: '102',
        replyAuthorId: '42',
        replyMessageId: '101',
      });
      expect(mocks.generateObject.mock.calls[0][0].prompt).toContain(
        '[REPLY_TO_MESSAGE_ID: 101]',
      );
    },
  );

  it.each([0.01, 0.5, 0.799])(
    'does not save a fact without sufficiently strong source support (%s)',
    async (support) => {
      mocks.support.fact_0 = support;
      mocks.generateObject.mockResolvedValue({
        object: {
          facts: [
            { content: 'Живёт в Казани', type: 'FACT', sourceMessageId: '101' },
          ],
        },
      });
      const ids = await analyzeUserMetaInfo(
        42n,
        [createMessage(101n, 'Хочу переехать в Казань')],
        999n,
      );
      expect(ids).toEqual([]);
      expect(mocks.prisma.userFact.create).not.toHaveBeenCalled();
      expect(mocks.embedQueryAndPassage).not.toHaveBeenCalled();
      expect(mocks.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: 'Живёт в Казани',
          outcome: support <= 0.1 ? 'rejected' : 'uncertain',
          action: 'skipped',
        }),
        999n,
      );
    },
  );

  it('verifies against the original message rather than a misleading summary', async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          {
            content: 'Раньше любил кофе',
            type: 'INTEREST',
            sourceMessageId: '101',
          },
        ],
      },
    });
    await analyzeUserMetaInfo(42n, [
      {
        ...createMessage(101n, 'Раньше любил кофе, сейчас не пью'),
        summary: 'Любит кофе',
      },
    ]);
    expect(mocks.evaluateJev.mock.calls[0][0].items.fact_0.source.text).toBe(
      'Раньше любил кофе, сейчас не пью',
    );
  });

  it('records a provider failure without saving any candidate in the batch', async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          { content: 'Любит Rust', type: 'INTEREST', sourceMessageId: '101' },
        ],
        aliases: [
          {
            userId: '42',
            alias: 'Саша',
            confidence: 0.8,
            sourceMessageId: '101',
            neutralForAddressing: true,
          },
        ],
      },
    });
    mocks.evaluateJev.mockRejectedValueOnce(new Error('Jev unavailable'));
    await expect(
      analyzeUserMetaInfo(
        42n,
        [createMessage(101n, 'Я Саша и люблю Rust')],
        999n,
      ),
    ).rejects.toThrow('analysis:verification:operation_failed');
    expect(mocks.prisma.userFact.create).not.toHaveBeenCalled();
    expect(mocks.saveAlias).not.toHaveBeenCalled();
    expect(mocks.createReview).toHaveBeenCalledTimes(2);
    expect(mocks.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', action: 'not_applied' }),
      999n,
    );
  });

  it('checks third-person reply identity independently from addressing suitability', async () => {
    mocks.support.alias_0 = 0.01;
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [],
        aliases: [
          {
            userId: '43',
            alias: 'Саша',
            confidence: 0.95,
            sourceMessageId: '101',
            neutralForAddressing: true,
          },
        ],
      },
    });
    await analyzeUserMetaInfo(
      42n,
      [
        {
          ...createMessage(101n, 'передай Саше привет, Саша'),
          replyToMessage: { ...createMessage(90n, 'Привет'), senderId: 43n },
        },
      ],
      999n,
    );
    expect(
      mocks.evaluateJev.mock.calls[0][0].items.alias_0.source.replyAuthorId,
    ).toBe('43');
    expect(mocks.saveAlias).not.toHaveBeenCalled();
  });

  it('uses Jev identity probability while refusing unsuitable automatic addressing', async () => {
    mocks.support.alias_0 = 0.92;
    mocks.support.alias_0_addressing = 0.2;
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [],
        aliases: [
          {
            userId: '42',
            alias: 'Шурик',
            confidence: 0.6,
            sourceMessageId: '101',
            neutralForAddressing: true,
          },
        ],
      },
    });
    mocks.saveAlias.mockResolvedValue(true);
    await analyzeUserMetaInfo(42n, [createMessage(101n, 'Я Шурик')], 999n);
    expect(mocks.saveAlias).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfidence: 0.92,
        neutralForAddressing: false,
      }),
    );
  });

  it.each(['unclear', 'contradiction'])(
    'does not mutate facts after an uncertain %s relation',
    async (relation) => {
      mocks.relation = relation;
      mocks.relationProbability = relation === 'unclear' ? 0.99 : 0.7;
      mocks.generateObject.mockResolvedValue({
        object: {
          facts: [
            {
              content: 'Теперь живёт в Казани',
              type: 'FACT',
              sourceMessageId: '101',
            },
          ],
        },
      });
      mocks.searchSimilarFacts.mockResolvedValue([
        { id: 200n, content: 'Раньше жил в Москве', similarity: 0.95 },
      ]);
      expect(
        await analyzeUserMetaInfo(42n, [
          createMessage(101n, 'Теперь живу в Казани'),
        ]),
      ).toEqual([]);
      expect(mocks.prisma.userFact.create).not.toHaveBeenCalled();
      expect(mocks.prisma.userFact.update).not.toHaveBeenCalled();
      expect(mocks.prisma.$executeRaw).not.toHaveBeenCalled();
      expect(mocks.finishReview).toHaveBeenCalledWith(
        'review-1',
        'skipped_uncertain',
        undefined,
      );
    },
  );

  it('does not choose an arbitrary existing fact when several contradictions match', async () => {
    mocks.relation = 'contradiction';
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          { content: 'Новый факт', type: 'FACT', sourceMessageId: '101' },
        ],
      },
    });
    mocks.searchSimilarFacts.mockResolvedValue([
      { id: 200n, content: 'Первый факт', similarity: 0.95 },
      { id: 201n, content: 'Второй факт', similarity: 0.94 },
    ]);
    expect(
      await analyzeUserMetaInfo(42n, [createMessage(101n, 'Новый факт')]),
    ).toEqual([]);
    expect(mocks.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('does not attribute the selected action to another pair when its audit write fails', async () => {
    mocks.relation = 'duplicate';
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          { content: 'Тот же факт', type: 'FACT', sourceMessageId: '101' },
        ],
      },
    });
    mocks.searchSimilarFacts.mockResolvedValue([
      { id: 200n, content: 'Тот же факт', similarity: 0.95 },
      { id: 201n, content: 'Похожий факт', similarity: 0.94 },
    ]);
    mocks.createReview
      .mockResolvedValueOnce('source-review')
      .mockRejectedValueOnce(new Error('audit unavailable'))
      .mockResolvedValueOnce('other-pair-review');
    mocks.prisma.userFact.findUnique.mockResolvedValue({
      id: 200n,
      content: 'Тот же факт',
      weight: 2,
    });
    mocks.prisma.userFact.findUniqueOrThrow.mockResolvedValue({
      userId: 42n,
      id: 200n,
      content: 'Тот же факт',
      weight: 2,
    });
    expect(
      await analyzeUserMetaInfo(42n, [createMessage(101n, 'Тот же факт')]),
    ).toEqual([200n]);
    expect(mocks.finishReview).toHaveBeenCalledWith(
      'other-pair-review',
      'not_selected',
      undefined,
    );
    expect(mocks.finishReview).toHaveBeenCalledWith(
      'source-review',
      'duplicate',
      '200',
    );
  });

  it('keeps independent facts and does not let a diagnostic write failure block persistence', async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          {
            content: 'Теперь живёт в Казани',
            type: 'FACT',
            sourceMessageId: '101',
          },
        ],
      },
    });
    mocks.searchSimilarFacts.mockResolvedValue([
      { id: 200n, content: 'Раньше жил в Москве', similarity: 0.95 },
    ]);
    mocks.createReview.mockRejectedValueOnce(
      new Error('database diagnostics unavailable'),
    );
    expect(
      await analyzeUserMetaInfo(42n, [
        createMessage(101n, 'Теперь живу в Казани'),
      ]),
    ).toEqual([100n]);
    expect(mocks.prisma.$executeRaw).toHaveBeenCalledOnce();
    expect(String(mocks.prisma.$executeRaw.mock.calls[0][0])).toContain(
      'embedding',
    );
    const logs = JSON.stringify(mocks.logger.info.mock.calls, (_key, value) =>
      typeof value === 'bigint' ? String(value) : value,
    );
    expect(logs).not.toContain('Теперь живёт в Казани');
    expect(logs).not.toContain('Теперь живу в Казани');
    expect(logs).not.toContain('Раньше жил в Москве');
  });

  it('learns only grounded public aliases in the same call while retaining valid facts', async () => {
    const parent = { ...createMessage(90n, 'Я Александр'), senderId: 43n };
    const messages = [
      { ...createMessage(101n, 'Санёк, привет'), replyToMessage: parent },
      {
        ...createMessage(102n, 'Я люблю Rust'),
        replyToMessage: { ...parent, private: true, text: 'PRIVATE SECRET' },
      },
      { ...createMessage(103n, 'Санёк'), senderId: 999n },
      { ...createMessage(104n, 'Санёк'), private: true },
    ];
    const valid = {
      userId: '43',
      alias: 'Санёк',
      confidence: 0.85,
      sourceMessageId: '101',
      neutralForAddressing: true,
    };
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [
          { content: 'Любит Rust', type: 'INTEREST', sourceMessageId: '102' },
          {
            content: 'Факт о чужом авторе',
            type: 'FACT',
            sourceMessageId: '103',
          },
        ],
        aliases: [
          valid,
          null,
          { ...valid, confidence: 1.1 },
          { ...valid, confidence: Number.NaN },
          { ...valid, userId: '987' },
          { ...valid, userId: '999' },
          { ...valid, sourceMessageId: '999' },
          { ...valid, alias: 'Шурик' },
          { ...valid, sourceMessageId: '102' },
          { ...valid, sourceMessageId: '103' },
          { ...valid, sourceMessageId: '104' },
        ],
      },
    });
    await analyzeUserMetaInfo(42n, messages, 999n);
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    const prompt = mocks.generateObject.mock.calls[0]?.[0].prompt;
    const schema = mocks.generateObject.mock.calls[0]?.[0].schema;
    expect(
      schema.parse({ facts: [], aliases: [{ ...valid, userId: 123 }, valid] })
        .aliases,
    ).toEqual([null, valid]);
    expect(prompt).toContain('[REPLY_AUTHOR_ID: 43]');
    expect(prompt).not.toContain('PRIVATE SECRET');
    expect(prompt).not.toContain('[MESSAGE_ID: 103]');
    expect(prompt).toContain('передай Саше привет');
    expect(mocks.saveAlias).toHaveBeenCalledTimes(1);
    expect(mocks.saveAlias).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 43n,
        alias: 'Санёк',
        sourceMessageId: 101n,
      }),
    );
    expect(mocks.prisma.userFact.create).toHaveBeenCalledTimes(1);
  });

  it('does not invent an alias for a third person and retries failed alias storage', async () => {
    mocks.generateObject.mockResolvedValue({
      object: { facts: [], aliases: [] },
    });
    await analyzeUserMetaInfo(
      42n,
      [createMessage(101n, 'передай Саше привет')],
      999n,
    );
    expect(mocks.saveAlias).not.toHaveBeenCalled();
    mocks.generateObject.mockResolvedValue({
      object: {
        facts: [],
        aliases: [
          {
            userId: '42',
            alias: 'Саша',
            confidence: 0.8,
            sourceMessageId: '101',
            neutralForAddressing: true,
          },
        ],
      },
    });
    mocks.saveAlias
      .mockRejectedValueOnce(new Error('alias storage unavailable'))
      .mockResolvedValue(true);
    await expect(
      analyzeUserMetaInfo(42n, [createMessage(101n, 'Я Саша')], 999n),
    ).rejects.toThrow('analysis:persistence:operation_failed');
    await analyzeUserMetaInfo(42n, [createMessage(101n, 'Я Саша')], 999n);
    expect(mocks.saveAlias).toHaveBeenCalledTimes(2);
  });
  it('propagates analysis failures to the durable job runner', async () => {
    const error = new Error('model unavailable');
    mocks.generateObject.mockRejectedValue(error);

    await expect(
      analyzeUserMetaInfo(42n, [createMessage(101n, 'Сообщение')]),
    ).rejects.toThrow('analysis:extraction:operation_failed');

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user_fact.analysis_failed',
        errorType: 'AnalysisStageError',
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
        if (stage === 'model')
          mocks.evaluateJev
            .mockImplementationOnce(jevResult)
            .mockRejectedValueOnce(error);
      }

      await expect(
        analyzeUserMetaInfo(42n, [createMessage(101n, 'Проверяемый факт')]),
      ).rejects.toThrow(
        stage === 'search'
          ? 'analysis:embedding:operation_failed'
          : `analysis:${stage === 'model' ? 'fact_relation' : stage}:operation_failed`,
      );

      expect(mocks.prisma.userFact.create).not.toHaveBeenCalled();
    },
  );

  it.each([0.8, 0.83])(
    'saves a valid fact with source support %s and includes IDs in the prompt',
    async (support) => {
      mocks.support.fact_0 = support;
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
      expect(mocks.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          policyVersion: 2,
          thresholds: { accept: 0.8, reject: 0.1 },
          outcome: 'accepted',
        }),
        undefined,
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
    },
  );

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
    mocks.relation = 'duplicate';
    mocks.prisma.userFact.findUnique.mockResolvedValue({
      id: 200n,
      content: 'Тот же факт',
      weight: 2,
    });
    mocks.prisma.userFact.findUniqueOrThrow.mockResolvedValue({
      userId: 42n,
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
    mocks.relation = 'duplicate';
    mocks.prisma.userFact.findUnique.mockResolvedValue({
      id: 200n,
      content: 'Тот же факт',
      weight: 2,
    });
    mocks.prisma.userFact.findUniqueOrThrow.mockResolvedValue({
      userId: 42n,
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
    mocks.relation = 'contradiction';
    mocks.prisma.userFact.findUnique.mockResolvedValue({
      id: 200n,
      content: 'Старый факт',
      weight: 2,
    });
    mocks.prisma.userFact.findUniqueOrThrow.mockResolvedValue({
      userId: 42n,
      id: 200n,
      content: 'Старый факт',
      weight: 2,
    });

    await analyzeUserMetaInfo(42n, [
      createMessage(101n, 'Старый факт'),
      createMessage(102n, 'Обновлённый факт'),
    ]);

    expect(mocks.prisma.$executeRaw).toHaveBeenCalledTimes(2);
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
