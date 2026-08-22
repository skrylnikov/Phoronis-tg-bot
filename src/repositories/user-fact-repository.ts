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
  return prisma.userFact.create({ data });
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
    where?: { type?: { in: Array<'TEXT_STYLE' | 'FACT' | 'INTEREST' | 'NEGATIVE_INTEREST'> } };
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

export async function findUserFactsWithImpactsRepo(where: {
  usageCount: { gt: number };
}) {
  return prisma.userFact.findMany({
    where,
    include: { FactImpact: true },
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

export async function findAllUserFactsRepo(userId: bigint) {
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
