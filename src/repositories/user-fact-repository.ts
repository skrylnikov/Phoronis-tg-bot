import { prisma } from '../db';
import type { FactType } from '../generated/prisma/client';

export async function findUserFactRepo(id: bigint) {
  return prisma.userFact.findUnique({
    where: { id },
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
      userId: data.userId,
      content: data.content,
      type: data.type,
      weight: data.weight,
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
        },
      });
    } else {
      await tx.$executeRaw`
        UPDATE "UserFact"
        SET "content" = ${input.content},
            "weight" = GREATEST("weight" - 1, 1),
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
