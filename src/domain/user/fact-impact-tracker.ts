import { logger } from '../../logger';
import {
  findMessageByIdRepo,
  updateManyUserFactsRepo,
} from '../../repositories';
import {
  createManyFactImpactsRepo,
  findFactImpactsRepo,
  recalculateFactImpactScoresRepo,
  updateManyFactImpactsRepo,
} from '../../repositories/fact-impact-repository';

export interface TelegramReaction {
  type: string;
  count: number;
}

export async function analyzeUserReaction(
  _botReply: string,
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
}

export async function recordUserReaction(
  botMessageId: number,
  _userId: number,
  chatId: number,
  userMessage?: string,
  telegramReactions?: TelegramReaction[],
) {
  const factImpacts = await findFactImpactsRepo({
    usedInMessageId: BigInt(botMessageId),
  });

  if (factImpacts.length === 0) {
    return;
  }

  const botMessage = await findMessageByIdRepo(
    BigInt(chatId),
    BigInt(botMessageId),
  );

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
  await updateManyFactImpactsRepo(
    {
      id: { in: factImpacts.map((fi) => fi.id) },
    },
    {
      userReaction: reaction.reaction,
      messageReaction: reaction.messageReaction,
    },
  );

  logger.info(
    {
      event: 'user_fact.reaction_recorded',
      factCount: factImpacts.length,
      reaction: reaction.reaction,
      messageReaction: reaction.messageReaction,
    },
    'User reaction recorded for facts',
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

  await createManyFactImpactsRepo(
    usedFactIds.map((factId) => ({
      factId,
      usedInMessageId: BigInt(botMessageId),
      timestamp: new Date(),
    })),
  );

  await updateManyUserFactsRepo(
    { id: { in: usedFactIds } },
    {
      usageCount: { increment: 1 },
      lastUsedAt: new Date(),
    },
  );

  logger.info(
    {
      event: 'user_fact.usage_tracked',
      factCount: usedFactIds.length,
      botMessageId,
    },
    'User fact usage tracked',
  );
}

export async function recalculateFactImpactScores() {
  const factCount = await recalculateFactImpactScoresRepo();

  logger.info(
    { event: 'user_fact.impact_scores_recalculated', factCount },
    'User fact impact scores recalculated',
  );
}

export async function getFactImpactStats(userId: number) {
  const {
    findTopUserFactsByScoreRepo,
    countUserFactsRepo,
    countUserFactsWithConditionRepo,
  } = await import('../../repositories');

  const facts = await findTopUserFactsByScoreRepo(BigInt(userId), 10);

  const total = await countUserFactsRepo(BigInt(userId));

  const withPositiveImpact = await countUserFactsWithConditionRepo(
    BigInt(userId),
    { impactScore: { gt: 0 } },
  );

  return {
    topFacts: facts,
    total,
    positiveRatio: total > 0 ? withPositiveImpact / total : 0,
  };
}
