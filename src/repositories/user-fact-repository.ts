import { prisma } from '../db';
import type { FactType } from '../generated/prisma/client';

export async function findUserFactRepo(id: bigint) {
  return prisma.userFact.findUnique({
    where: { id },
  });
}

export async function updateUserFactRepo(
  id: bigint,
  data: {
    weight?: number;
    updatedAt?: Date;
    sourceChatId?: bigint;
    sourceMessageId?: bigint;
    content?: string;
    usageCount?: { increment: number };
    lastUsedAt?: Date;
    impactScore?: number;
  },
) {
  return prisma.userFact.update({
    where: { id },
    data,
  });
}

export async function updateManyUserFactsRepo(
  where: { id: { in: bigint[] } },
  data: {
    usageCount?: { increment: number };
    lastUsedAt?: Date;
    impactScore?: number;
  },
) {
  return prisma.userFact.updateMany({
    where,
    data,
  });
}

export async function createUserFactRepo(data: {
  userId: bigint;
  content: string;
  type: FactType;
  weight: number;
  sourceChatId: bigint;
  sourceMessageId: bigint;
}) {
  return prisma.userFact.create({
    data: {
      ...data,
      evidence: {
        create: {
          sourceChatId: data.sourceChatId,
          sourceMessageId: data.sourceMessageId,
        },
      },
    },
  });
}

export async function applyUserFactEvidenceRepo(input: {
  factId: bigint;
  content: string;
  sourceChatId: bigint;
  sourceMessageId: bigint;
  reason: 'duplicate' | 'contradiction';
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const evidence = await tx.userFactEvidence.createMany({
      data: [
        {
          factId: input.factId,
          sourceChatId: input.sourceChatId,
          sourceMessageId: input.sourceMessageId,
        },
      ],
      skipDuplicates: true,
    });
    if (evidence.count === 0) return false;

    const fact = await tx.userFact.findUniqueOrThrow({
      where: { id: input.factId },
    });
    if (input.reason === 'duplicate') {
      await tx.userFact.update({
        where: { id: input.factId },
        data: {
          weight: { increment: 1 },
          updatedAt: new Date(),
          sourceChatId: input.sourceChatId,
          sourceMessageId: input.sourceMessageId,
        },
      });
    } else {
      await tx.$executeRaw`
        UPDATE "UserFact"
        SET "content" = ${input.content},
            "weight" = GREATEST("weight" - 1, 1),
            "sourceChatId" = ${input.sourceChatId},
            "sourceMessageId" = ${input.sourceMessageId},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${input.factId}
      `;
    }

    await tx.factHistory.create({
      data: {
        factId: input.factId,
        previousContent: fact.content,
        newContent: input.content,
        weightChange: input.reason === 'duplicate' ? 1 : -1,
        reason: input.reason,
      },
    });
    return true;
  });
}

export async function createFactHistoryRepo(data: {
  factId: bigint;
  previousContent: string;
  newContent: string;
  weightChange: number;
  reason: string;
}) {
  return prisma.factHistory.create({ data });
}

export async function findUserFactsRepo(
  userId: bigint,
  options: {
    orderBy?: { updatedAt: 'desc' | 'asc' };
    take?: number;
    where?: {
      evidence?: { some: { sourceChatId: bigint } };
      type?: {
        in: Array<'TEXT_STYLE' | 'FACT' | 'INTEREST' | 'NEGATIVE_INTEREST'>;
      };
    };
  } = {},
) {
  return prisma.userFact.findMany({
    where: {
      userId,
      ...options.where,
    },
    orderBy: options.orderBy,
    take: options.take,
  });
}

export async function countUserFactsRepo(userId: bigint) {
  return prisma.userFact.count({
    where: { userId },
  });
}

export async function countUserFactsWithConditionRepo(
  userId: bigint,
  condition: { impactScore: { gt: number } },
) {
  return prisma.userFact.count({
    where: { userId, ...condition },
  });
}

export async function findTopUserFactsByScoreRepo(
  userId: bigint,
  limit: number,
) {
  return prisma.userFact.findMany({
    where: { userId },
    orderBy: { impactScore: 'desc' },
    take: limit,
  });
}

export async function findAllUserFactsRepo(
  userId: bigint,
  sourceChatId?: bigint,
) {
  return prisma.userFact.findMany({
    where: {
      userId,
      ...(sourceChatId === undefined
        ? {}
        : { evidence: { some: { sourceChatId } } }),
    },
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
export async function updateUserFactsWeightRepo(): Promise<number> {
  const result = await prisma.userFact.updateMany({
    where: {
      updatedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      weight: { gte: 2 },
    },
    data: { weight: { decrement: 1 } },
  });
  return result.count;
}
