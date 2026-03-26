import { generateText, Output } from 'ai';
import { z } from 'zod';
import { openRouter } from '../../ai/ai';
import { prisma } from '../../db';
import { logger } from '../../logger';

const reactionSchema = z.object({
  reaction: z
    .enum(['positive', 'negative', 'neutral', 'correction'])
    .describe('Реакция пользователя на ответ'),
  messageReaction: z
    .enum(['continue', 'question', 'clarification', 'ignore', 'none'])
    .describe('Тип продолжения диалога'),
  confidence: z.number().min(0).max(1).describe('Уверенность в оценке (0-1)'),
});

export interface TelegramReaction {
  type: string;
  count: number;
}

export async function analyzeUserReaction(
  botReply: string,
  userMessage?: string,
  telegramReactions?: TelegramReaction[],
) {
  if (telegramReactions && telegramReactions.length > 0) {
    const positiveCount = telegramReactions
      .filter((r) => ['👍', '❤️', '🔥', '👏', '🎉', '😄', '🤩'].includes(r.type))
      .reduce((sum, r) => sum + r.count, 0);

    const negativeCount = telegramReactions
      .filter((r) => ['👎', '😠', '🚫', '😡', '💔', '😢'].includes(r.type))
      .reduce((sum, r) => sum + r.count, 0);

    if (positiveCount > negativeCount && positiveCount > 0) {
      return {
        reaction: 'positive' as const,
        confidence: 0.9,
        messageReaction: 'none' as const,
      };
    }
    if (negativeCount > positiveCount && negativeCount > 0) {
      return {
        reaction: 'negative' as const,
        confidence: 0.9,
        messageReaction: 'none' as const,
      };
    }
  }

  if (!userMessage) {
    return {
      reaction: 'neutral' as const,
      confidence: 0.5,
      messageReaction: 'none' as const,
    };
  }

  return null;

  //   const result = await generateText({
  //     model: openRouter('google/gemini-2.5-flash-lite'),
  //     output: Output.object({ schema: reactionSchema }),
  //     prompt: `Проанализируй реакцию пользователя на ответ бота.

  // Ответ бота:
  // "${botReply}"

  // Ответ пользователя:
  // "${userMessage}"

  // Определи:
  // 1. reaction: позитивная/негативная/нейтральная/исправление ошибки
  // 2. messageReaction: продолжение диалога/уточняющий вопрос/пояснение/игнорирование/нет реакции
  // 3. confidence: уверенность в оценке (0-1)`,
  //     temperature: 0,
  //   });

  //   return {
  //     reaction: result.output.reaction,
  //     messageReaction: result.output.messageReaction,
  //     confidence: result.output.confidence,
  //   };
}

export async function recordUserReaction(
  botMessageId: number,
  _userId: number,
  chatId: number,
  userMessage?: string,
  telegramReactions?: TelegramReaction[],
) {
  const factImpacts = await prisma.factImpact.findMany({
    where: { usedInMessageId: BigInt(botMessageId) },
  });

  if (factImpacts.length === 0) {
    return;
  }

  const botMessage = await prisma.message.findUnique({
    where: {
      chatId_id: { chatId: BigInt(chatId), id: BigInt(botMessageId) },
    },
  });

  const botReply = botMessage?.text || botMessage?.summary || '';

  if (!botReply) {
    return;
  }

  const reaction = await analyzeUserReaction(
    botReply,
    userMessage,
    telegramReactions,
  );

  if (!reaction) {
    return;
  }
  await prisma.factImpact.updateMany({
    where: {
      id: { in: factImpacts.map((fi) => fi.id) },
    },
    data: {
      userReaction: reaction.reaction,
      messageReaction: reaction.messageReaction,
    },
  });

  logger.info(
    `Recorded reaction for ${factImpacts.length} facts: ${JSON.stringify(reaction)}`,
  );
}

export async function trackFactUsage(
  _userId: number,
  usedFactIds: bigint[],
  botMessageId: number,
) {
  if (usedFactIds.length === 0) {
    return;
  }

  await prisma.factImpact.createMany({
    data: usedFactIds.map((factId) => ({
      factId,
      usedInMessageId: BigInt(botMessageId),
      timestamp: new Date(),
    })),
  });

  await prisma.userFact.updateMany({
    where: { id: { in: usedFactIds } },
    data: {
      usageCount: { increment: 1 },
      lastUsedAt: new Date(),
    },
  });

  logger.info(
    `Tracked usage for ${usedFactIds.length} facts in message ${botMessageId}`,
  );
}

export async function recalculateFactImpactScores() {
  const facts = await prisma.userFact.findMany({
    where: { usageCount: { gt: 0 } },
    include: { FactImpact: true },
  });

  for (const fact of facts) {
    const impacts = fact.FactImpact;

    if (impacts.length === 0) {
      continue;
    }

    let score = 0;

    for (const impact of impacts) {
      let deltaScore = 0;

      switch (impact.userReaction) {
        case 'positive':
          deltaScore += 2;
          break;
        case 'negative':
          deltaScore -= 2;
          break;
        case 'correction':
          deltaScore -= 1;
          break;
      }

      switch (impact.messageReaction) {
        case 'question':
          deltaScore += 1.5;
          break;
        case 'clarification':
          deltaScore += 1.5;
          break;
        case 'continue':
          deltaScore += 1;
          break;
        case 'ignore':
          deltaScore -= 0.5;
          break;
      }

      const daysSince =
        (Date.now() - impact.timestamp.getTime()) / (1000 * 60 * 60 * 24);
      const timeDecay = Math.exp(-daysSince / 30);
      score += deltaScore * timeDecay;
    }

    const normalizedScore = score / Math.sqrt(impacts.length);

    await prisma.userFact.update({
      where: { id: fact.id },
      data: { impactScore: normalizedScore },
    });
  }

  logger.info(`Recalculated impact scores for ${facts.length} facts`);
}

export async function getFactImpactStats(userId: number) {
  const facts = await prisma.userFact.findMany({
    where: { userId: BigInt(userId) },
    orderBy: { impactScore: 'desc' },
    take: 10,
  });

  const total = await prisma.userFact.count({
    where: { userId: BigInt(userId) },
  });

  const withPositiveImpact = await prisma.userFact.count({
    where: { userId: BigInt(userId), impactScore: { gt: 0 } },
  });

  return {
    topFacts: facts,
    total,
    positiveRatio: total > 0 ? withPositiveImpact / total : 0,
  };
}
