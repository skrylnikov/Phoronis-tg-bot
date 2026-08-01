import { generateObject, generateText, Output } from 'ai';
import { z } from 'zod';
import { utilityModel } from '../../ai/ai';
import { embedQueryAndPassage } from '../../ai/embedding/client';
import {
  searchSimilarFacts,
  updateFactEmbedding,
} from '../../ai/embedding/store';
import { langfuse } from '../../ai/langfuse';
import { prisma } from '../../db';
import type { Message } from '../../generated/prisma/client';
import { logger } from '../../logger';

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

interface FactSource {
  chatId: bigint;
  messageId: bigint;
}

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

const SEARCH_THRESHOLD = 0.82;
const similarityCheckTimeoutMs = 10_000;

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
    let result = `[MESSAGE_ID: ${String(m.id)}]`;

    if (m.replyToMessage) {
      const replyContent =
        m.replyToMessage.summary || m.replyToMessage.text || '';
      if (replyContent) {
        result += `\n[REPLY]: ${replyContent}`;
      }
    }

    if (messageContent) {
      result += `\n[MESSAGE]: ${messageContent}`;
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
    const { queryEmbedding, passageEmbedding } =
      await embedQueryAndPassage(content);
    const searchResults = await searchSimilarFacts(
      userId,
      queryEmbedding,
      SEARCH_THRESHOLD,
      5,
      type,
    );

    if (searchResults.length === 0) {
      return {
        isDuplicate: false,
        isContradiction: false,
        embedding: passageEmbedding,
      };
    }

    const candidates = searchResults
      .map((result) => `[ID: ${String(result.id)}] ${result.content}`)
      .join('\n');

    const llmResult = await generateText({
      model: utilityModel,
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
      abortSignal: AbortSignal.timeout(similarityCheckTimeoutMs),
    });

    if (llmResult.output.duplicateId) {
      return {
        isDuplicate: true,
        isContradiction: false,
        similarFactId: BigInt(llmResult.output.duplicateId),
        embedding: passageEmbedding,
      };
    }

    if (llmResult.output.contradictionId) {
      return {
        isDuplicate: false,
        isContradiction: true,
        similarFactId: BigInt(llmResult.output.contradictionId),
        embedding: passageEmbedding,
      };
    }

    return {
      isDuplicate: false,
      isContradiction: false,
      embedding: passageEmbedding,
    };
  } catch (error) {
    const noOutput =
      error instanceof Error && error.name === 'AI_NoOutputGeneratedError';
    logger[noOutput ? 'warn' : 'error'](
      {
        event: noOutput
          ? 'user_fact.similarity_check_unavailable'
          : 'user_fact.similarity_check_failed',
        err: error,
      },
      noOutput
        ? 'Fact similarity check returned no structured output'
        : 'Error checking for similar facts',
    );
    return { isDuplicate: false, isContradiction: false };
  }
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
  source: FactSource,
  weight = 1,
) {
  const checkResult = await checkForSimilarFacts(userId, content);

  if (checkResult.isDuplicate && checkResult.similarFactId) {
    const existingFact = await prisma.userFact.findUnique({
      where: { id: checkResult.similarFactId },
    });

    if (existingFact) {
      const sourceData =
        existingFact.sourceChatId === null ||
        existingFact.sourceMessageId === null
          ? {
              sourceChatId: source.chatId,
              sourceMessageId: source.messageId,
            }
          : {};

      await prisma.userFact.update({
        where: { id: checkResult.similarFactId },
        data: {
          weight: existingFact.weight + 1,
          updatedAt: new Date(),
          ...sourceData,
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
        await updateFactEmbedding(
          checkResult.similarFactId,
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
          sourceChatId: source.chatId,
          sourceMessageId: source.messageId,
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
        await updateFactEmbedding(
          checkResult.similarFactId,
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
      sourceChatId: source.chatId,
      sourceMessageId: source.messageId,
    },
  });

  if (checkResult.embedding) {
    await updateFactEmbedding(fact.id, checkResult.embedding);
  }

  return fact.id;
}

const extractedFactSchema = factSchema.extend({
  sourceMessageId: z
    .string()
    .describe('ID сообщения из переданного списка, подтверждающего факт'),
});

type ExtractedFact = z.infer<typeof extractedFactSchema>;

const factExtractionSchema = z.object({
  facts: z
    .array(extractedFactSchema)
    .describe(
      'Массив извлечённых фактов о пользователе (стили общения, факты, интересы)',
    ),
});

function resolveFactSource(
  userId: bigint,
  fact: ExtractedFact,
  messagesById: Map<bigint, Message & { replyToMessage?: Message | null }>,
): FactSource | null {
  if (!/^\d+$/.test(fact.sourceMessageId)) {
    logger.warn(
      {
        event: 'user_fact.invalid_source_message',
        userId: String(userId),
        sourceMessageId: fact.sourceMessageId,
        inputMessageCount: messagesById.size,
      },
      'Skipping fact with an invalid source message',
    );
    return null;
  }

  const sourceMessageId = BigInt(fact.sourceMessageId);
  const sourceMessage = messagesById.get(sourceMessageId);

  if (!sourceMessage || sourceMessage.senderId !== userId) {
    logger.warn(
      {
        event: 'user_fact.invalid_source_message',
        userId: String(userId),
        sourceMessageId: fact.sourceMessageId,
        inputMessageCount: messagesById.size,
      },
      'Skipping fact with an invalid source message',
    );
    return null;
  }

  return {
    chatId: sourceMessage.chatId,
    messageId: sourceMessage.id,
  };
}

export async function analyzeUserMetaInfo(
  userId: bigint,
  messages: Array<Message & { replyToMessage?: Message | null }>,
) {
  const messagesById = new Map(
    messages.map((message) => [message.id, message]),
  );
  const analysisContext = {
    model: utilityModel.modelId,
    inputMessageCount: messages.length,
    existingFactCount: 0,
    promptLength: 0,
    validFactCount: 0,
    skippedFactCount: 0,
  };

  try {
    const formattedMessages = await formatMessagesWithReplies(messages);

    const existingFacts = await prisma.userFact.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
    analysisContext.existingFactCount = existingFacts.length;

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

Извлеки новые факты о пользователе, стилях общения и интересах. НЕ повторяй существующие факты, а только дополняй их.
Для каждого факта обязательно укажи sourceMessageId — ID наиболее подходящего сообщения из блоков [MESSAGE_ID]. Используй только ID из переданного списка и не придумывай новые ID. Если факт нельзя подтвердить одним из переданных сообщений, не включай его в ответ.`;

    const analysisPrompt = `
${systemPrompt}

${userPrompt}
`.trim();
    analysisContext.promptLength = analysisPrompt.length;

    const result = await generateObject({
      model: utilityModel,
      schema: factExtractionSchema,
      prompt: analysisPrompt,
      temperature: 0,
    });

    const savedFactIds: bigint[] = [];

    for (const fact of result.object.facts) {
      const source = resolveFactSource(userId, fact, messagesById);
      if (!source) {
        analysisContext.skippedFactCount += 1;
        continue;
      }

      analysisContext.validFactCount += 1;
      const factId = await saveUserFact(
        userId,
        fact.content,
        fact.type,
        source,
      );
      savedFactIds.push(factId);
    }

    logger.info(
      {
        event: 'user_fact.analysis_completed',
        ...analysisContext,
        userId,
        savedFactCount: savedFactIds.length,
      },
      'User fact analysis completed',
    );

    return savedFactIds;
  } catch (error) {
    logger.error(
      { event: 'user_fact.analysis_failed', ...analysisContext, err: error },
      'Error analyzing user meta info',
    );
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

export async function getAllUserFacts(userId: bigint) {
  return prisma.userFact.findMany({
    where: { userId },
    select: {
      content: true,
      type: true,
      weight: true,
      confidence: true,
      updatedAt: true,
      expiresAt: true,
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  });
}
