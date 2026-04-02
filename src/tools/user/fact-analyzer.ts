import type { Message } from '@prisma/client';
import type { Schemas } from '@qdrant/js-client-rest';
import { embed, generateObject, generateText, Output } from 'ai';
import { z } from 'zod';
import { openRouter } from '../../ai/ai';
import { langfuse } from '../../ai/langfuse';
import { prisma } from '../../db';
import { logger } from '../../logger';
import { qdrantClient } from '../../qdrant';

type FactType = 'TEXT_STYLE' | 'FACT' | 'INTEREST' | 'NEGATIVE_INTEREST';

const factSchema = z.object({
  content: z.string().describe('Содержание факта/стиля/интереса'),
  type: z
    .enum(['TEXT_STYLE', 'FACT', 'INTEREST', 'NEGATIVE_INTEREST'])
    .describe(
      'Тип информации: стиль общения, факт, интерес, то что не нравится',
    ),
});

type Fact = z.infer<typeof factSchema>;

const factsCheckSchema = z.object({
  duplicateId: z
    .string()
    .nullable()
    .describe('ID дубликата, если найден (в формате number из payload)'),
  contradictionId: z
    .string()
    .nullable()
    .describe('ID противоречащего факта, если найден'),
  reason: z.string().describe('Объяснение решения'),
});

const SEARCH_THRESHOLD = 0.6;

interface FactCheckResult {
  isDuplicate: boolean;
  isContradiction: boolean;
  similarFactId?: bigint;
  embedding?: number[];
}

async function formatMessagesWithReplies(
  messages: Array<Message & { replyToMessage?: Message | null }>,
): Promise<string> {
  const formatted = messages.map((m) => {
    const messageContent = m.summary || m.text || '';
    let result = '';

    if (m.replyToMessage) {
      const replyContent =
        m.replyToMessage.summary || m.replyToMessage.text || '';
      if (replyContent) {
        result += `[REPLY]: ${replyContent}\n`;
      }
    }

    if (messageContent) {
      result += `[MESSAGE]: ${messageContent}`;
    }

    return result.trim();
  });

  return formatted.filter((m) => m.length > 0).join('\n\n');
}

async function checkForSimilarFacts(
  userId: bigint,
  content: string,
  type?: FactType,
): Promise<FactCheckResult> {
  try {
    const result = await embed({
      model: openRouter.textEmbeddingModel('qwen/qwen3-embedding-8b'),
      value: content,
      providerOptions: {
        llamaGate: {
          dimensions: 4096,
        },
      },
    });

    const mustConditions = [
      {
        key: 'userId',
        match: {
          value: userId.toString(),
        },
      },
    ];

    if (type) {
      mustConditions.push({
        key: 'type',
        match: {
          value: type,
        },
      });
    }

    const filter: Schemas['Filter'] = {
      must: mustConditions,
    };

    const searchResults = await qdrantClient.search('user-facts', {
      vector: result.embedding,
      filter,
      score_threshold: SEARCH_THRESHOLD,
      limit: 5,
      with_payload: true,
    });

    if (searchResults.length === 0) {
      return {
        isDuplicate: false,
        isContradiction: false,
        embedding: result.embedding,
      };
    }

    const candidates = searchResults
      .map((r) => `[ID: ${String(r.id)}] ${r.payload?.content as string}`)
      .join('\n');

    const llmResult = await generateText({
      model: openRouter('google/gemma-3n-e4b-it'),
      output: Output.object({ schema: factsCheckSchema }),
      prompt: `Анализируй новый факт и существующие факты на предмет дубликатов и противоречий.

Новый факт:
"${content}"

Существующие похожие факты:
${candidates}

Определи:
1. Есть ли точный дубликат (то же самое утверждение с тем же смыслом)
2. Есть ли противоречие (противоположное утверждение об одном и том же)

Если дубликат найден - верни его ID.
Если противоречие найдено - верни его ID.
Если нет ни того ни другого - верни null для обоих полей.`,
      temperature: 0,
    });

    if (llmResult.output.duplicateId) {
      return {
        isDuplicate: true,
        isContradiction: false,
        similarFactId: BigInt(llmResult.output.duplicateId),
        embedding: result.embedding,
      };
    }

    if (llmResult.output.contradictionId) {
      return {
        isDuplicate: false,
        isContradiction: true,
        similarFactId: BigInt(llmResult.output.contradictionId),
        embedding: result.embedding,
      };
    }

    return {
      isDuplicate: false,
      isContradiction: false,
      embedding: result.embedding,
    };
  } catch (error) {
    logger.error(error, 'Error checking for similar facts');
    return { isDuplicate: false, isContradiction: false };
  }
}

async function upsertFactEmbedding(
  factId: bigint,
  content: string,
  userId: bigint,
  type: FactType,
  embedding: number[],
) {
  await qdrantClient.upsert('user-facts', {
    points: [
      {
        id: Number(factId),
        vector: embedding,
        payload: {
          content,
          userId: userId.toString(),
          type,
        },
      },
    ],
  });
}

async function createFactHistory(
  factId: bigint,
  previousContent: string,
  newContent: string,
  weightChange: number,
  reason: string,
) {
  await prisma.factHistory.create({
    data: {
      factId,
      previousContent,
      newContent,
      weightChange,
      reason,
    },
  });
}

async function saveUserFact(
  userId: bigint,
  content: string,
  type: FactType,
  sourceMessageId?: bigint,
  weight = 1,
) {
  const checkResult = await checkForSimilarFacts(userId, content);

  if (checkResult.isDuplicate && checkResult.similarFactId) {
    const existingFact = await prisma.userFact.findUnique({
      where: { id: checkResult.similarFactId },
    });

    if (existingFact) {
      await prisma.userFact.update({
        where: { id: checkResult.similarFactId },
        data: {
          weight: existingFact.weight + 1,
          updatedAt: new Date(),
        },
      });

      await createFactHistory(
        checkResult.similarFactId,
        existingFact.content,
        content,
        1,
        'duplicate',
      );

      if (checkResult.embedding) {
        await upsertFactEmbedding(
          checkResult.similarFactId,
          content,
          userId,
          existingFact.type,
          checkResult.embedding,
        );
      }
    }

    return checkResult.similarFactId;
  }

  if (checkResult.isContradiction && checkResult.similarFactId) {
    const existingFact = await prisma.userFact.findUnique({
      where: { id: checkResult.similarFactId },
    });

    if (existingFact) {
      await prisma.userFact.update({
        where: { id: checkResult.similarFactId },
        data: {
          content,
          weight: Math.max(existingFact.weight - 1, 1),
          updatedAt: new Date(),
        },
      });

      await createFactHistory(
        checkResult.similarFactId,
        existingFact.content,
        content,
        -1,
        'contradiction',
      );

      if (checkResult.embedding) {
        await upsertFactEmbedding(
          checkResult.similarFactId,
          content,
          userId,
          existingFact.type,
          checkResult.embedding,
        );
      }
    }

    return checkResult.similarFactId;
  }

  const fact = await prisma.userFact.create({
    data: {
      userId,
      content,
      type,
      weight,
      sourceMessageId,
    },
  });

  if (checkResult.embedding) {
    await upsertFactEmbedding(
      fact.id,
      content,
      userId,
      type,
      checkResult.embedding,
    );
  }

  return fact.id;
}

const factExtractionSchema = z.object({
  facts: z
    .array(factSchema)
    .describe(
      'Массив извлечённых фактов о пользователе (стили общения, факты, интересы)',
    ),
});

export async function analyzeUserMetaInfo(
  userId: bigint,
  messages: Array<Message & { replyToMessage?: Message | null }>,
) {
  try {
    const formattedMessages = await formatMessagesWithReplies(messages);

    const existingFacts = await prisma.userFact.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    const existingFactsFormatted = existingFacts
      .map((f) => `[${f.type}] ${f.content} (вес: ${f.weight})`)
      .join('\n');

    const prompt = await langfuse.getPrompt('meta-analyzer');
    const systemPrompt = prompt.compile();

    const userPrompt = `Проанализируй сообщения пользователя и извлеки информацию о нём.

Существующая информация о пользователе:
${existingFactsFormatted || 'Пока нет информации'}

Новые сообщения пользователя:
${formattedMessages}

Извлеки новые факты о пользователе, стилях общения и интересах. НЕ повторяй существующие факты, а только дополняй их.`;

    const result = await generateObject({
      model: openRouter('google/gemma-3n-e4b-it'),
      schema: factExtractionSchema,
      prompt: `
${systemPrompt}

${userPrompt}
`.trim(),
      temperature: 0,
    });

    const savedFactIds: bigint[] = [];

    for (const fact of result.object.facts) {
      const factId = await saveUserFact(userId, fact.content, fact.type);
      savedFactIds.push(factId);
    }

    logger.info(`Analyzed user ${userId}, saved ${savedFactIds.length} facts`);

    return savedFactIds;
  } catch (error) {
    logger.error(error, 'Error analyzing user meta info');
    return null;
  }
}

export async function getTopUserFacts(
  userId: bigint,
  options: {
    limit?: number;
    types?: FactType[];
  } = {},
): Promise<Array<Fact & { weight: number; confidence: number }>> {
  const { limit = 10, types } = options;

  const facts = await prisma.userFact.findMany({
    where: {
      userId,
      ...(types && { type: { in: types } }),
    },
    orderBy: { updatedAt: 'desc' },
  });

  const now = new Date();
  const ranked = facts
    .map((fact) => {
      const daysSinceUpdate =
        (now.getTime() - fact.updatedAt.getTime()) / (1000 * 60 * 60 * 24);

      const rankScore =
        fact.weight * 2 +
        fact.confidence * 0.5 +
        fact.impactScore * 1.5 +
        (fact.type === 'INTEREST' ? 5 : 0) +
        (fact.expiresAt && fact.expiresAt > now ? 10 : 0) -
        daysSinceUpdate * 0.1;

      return { ...fact, rankScore };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, limit);

  return ranked.map(({ content, type, weight, confidence }) => ({
    content,
    type,
    weight,
    confidence,
  }));
}
