import { prisma } from '../db';
import { Prisma } from '../generated/prisma/client';

export type QuotaScope = 'USER' | 'CHAT';
export type QuotaKind = 'PRIMARY_RESPONSE' | 'IMAGE' | 'VOICE' | 'ANALYSIS';
export type NoticeKind = 'LITE_FALLBACK' | 'IMAGE_LIMIT' | 'VOICE_LIMIT';

export async function reserveQuotaUsage(
  scope: QuotaScope,
  ownerId: bigint,
  chatId: bigint,
  kind: QuotaKind,
  day: Date,
  limit: number,
): Promise<boolean> {
  if (limit === Infinity) return true;
  if (limit <= 0) return false;

  const result = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    INSERT INTO "QuotaUsage" ("id", "scope", "ownerId", "chatId", "kind", "date", "count")
    VALUES (${crypto.randomUUID()}, ${scope}::"QuotaScope", ${ownerId}, ${chatId}, ${kind}::"QuotaKind", ${day}, 1)
    ON CONFLICT ("scope", "ownerId", "chatId", "kind", "date") DO UPDATE
    SET "count" = "QuotaUsage"."count" + 1
    WHERE "QuotaUsage"."count" < ${limit}
    RETURNING "count"
  `);

  return result.length === 1;
}

export async function releaseQuotaUsage(
  scope: QuotaScope,
  ownerId: bigint,
  chatId: bigint,
  kind: QuotaKind,
  day: Date,
): Promise<void> {
  await prisma.quotaUsage.updateMany({
    where: {
      scope,
      ownerId,
      chatId,
      kind,
      date: day,
      count: { gt: 0 },
    },
    data: { count: { decrement: 1 } },
  });
}

export async function findQuotaUsages(
  userId: bigint,
  chatId: bigint | undefined,
  day: Date,
) {
  return prisma.quotaUsage.findMany({
    where: {
      date: day,
      OR: [
        { scope: 'USER', ownerId: userId, chatId: 0n },
        ...(chatId
          ? [{ scope: 'CHAT' as const, ownerId: userId, chatId }]
          : []),
      ],
    },
  });
}

export async function updateLimitNotice(
  userId: bigint,
  chatId: bigint,
  kind: NoticeKind,
  cutoff: Date,
  now: Date,
) {
  return prisma.limitNotice.updateMany({
    where: { userId, chatId, kind, sentAt: { lte: cutoff } },
    data: { sentAt: now },
  });
}

export async function createLimitNotice(
  userId: bigint,
  chatId: bigint,
  kind: NoticeKind,
  now: Date,
) {
  return prisma.limitNotice.create({
    data: { userId, chatId, kind, sentAt: now },
  });
}
