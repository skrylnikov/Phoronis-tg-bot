import { prisma } from '../db';
import type { Prisma } from '../generated/prisma/client';

export const decisionReviewRetentionDays = 7;

export function decisionReviewCutoff(now = new Date()): Date {
  return new Date(now.getTime() - decisionReviewRetentionDays * 86_400_000);
}

export async function createDecisionReviewRepo(
  data: Prisma.DecisionReviewUncheckedCreateInput,
  botId?: bigint,
): Promise<string | undefined> {
  const source = await prisma.message.findUnique({
    where: {
      chatId_id: { chatId: data.sourceChatId, id: data.sourceMessageId },
    },
    select: { private: true, senderId: true },
  });
  if (source?.private !== false || source.senderId === botId) return;
  const review = await prisma.decisionReview.create({ data });
  return review.id;
}

export async function finishDecisionReviewRepo(
  id: string,
  action: string,
  resultId?: string,
): Promise<void> {
  await prisma.decisionReview.updateMany({
    where: { id },
    data: { action, resultId },
  });
}

export async function cleanDecisionReviewsRepo(
  now = new Date(),
): Promise<number> {
  const result = await prisma.decisionReview.deleteMany({
    where: {
      OR: [
        { createdAt: { lt: decisionReviewCutoff(now) } },
        { sourceMessage: { OR: [{ private: true }, { private: null }] } },
      ],
    },
  });
  return result.count;
}

export async function readDecisionReviewReportRepo(options: {
  days: number;
  limit: number;
  chatId?: bigint;
  now?: Date;
}) {
  const now = options.now ?? new Date();
  const since = new Date(
    now.getTime() -
      Math.min(options.days, decisionReviewRetentionDays) * 86_400_000,
  );
  const where: Prisma.DecisionReviewWhereInput = {
    createdAt: { gte: since, lte: now },
    ...(options.chatId === undefined ? {} : { sourceChatId: options.chatId }),
    sourceMessage: { private: false },
  };
  const include = {
    sourceMessage: {
      select: {
        text: true,
        summary: true,
        senderId: true,
        sentAt: true,
        replyToMessage: {
          select: {
            chatId: true,
            senderId: true,
            text: true,
            summary: true,
            private: true,
          },
        },
      },
    },
  } as const;
  const [groups, latency, concerns] = await Promise.all([
    prisma.decisionReview.groupBy({
      by: ['kind', 'outcome', 'action', 'actualModel'],
      where,
      _count: true,
      orderBy: [{ kind: 'asc' }, { outcome: 'asc' }, { action: 'asc' }],
    }),
    prisma.decisionReview.aggregate({
      where,
      _avg: { durationMs: true },
      _max: { durationMs: true },
    }),
    prisma.decisionReview.findMany({
      where: {
        ...where,
        OR: [
          { outcome: { not: 'accepted' } },
          { action: { in: ['pending', 'failed', 'skipped_uncertain'] } },
        ],
      },
      include,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.limit,
    }),
  ]);
  const remaining = options.limit - concerns.length;
  const accepted =
    remaining > 0
      ? await prisma.decisionReview.findMany({
          where: { ...where, id: { notIn: concerns.map((row) => row.id) } },
          include,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: remaining,
        })
      : [];
  const examples = [...concerns, ...accepted].map(
    ({ sourceMessage, ...row }) => {
      const reply = sourceMessage.replyToMessage;
      return {
        ...row,
        source: {
          text: sourceMessage.text || sourceMessage.summary || '',
          authorId: sourceMessage.senderId,
          sentAt: sourceMessage.sentAt,
          ...(reply?.private === false && reply.chatId === row.sourceChatId
            ? {
                reply: {
                  authorId: reply.senderId,
                  text: reply.text || reply.summary || '',
                },
              }
            : {}),
        },
      };
    },
  );
  return {
    since,
    until: now,
    total: groups.reduce((sum, group) => sum + group._count, 0),
    groups,
    latency: {
      averageMs: latency._avg.durationMs,
      maxMs: latency._max.durationMs,
    },
    examples,
  };
}
