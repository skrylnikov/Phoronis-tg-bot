import { prisma } from '../db';
import type { FactType, Prisma } from '../generated/prisma/client';
import { throwIfUpdateAborted } from '../update-signal';

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
  embedding?: number[];
}) {
  return prisma.$transaction(async (tx) => {
    await lockFactUser(tx, data.userId);
    throwIfUpdateAborted();
    const source = await tx.message.findUnique({
      where: {
        chatId_id: { chatId: data.sourceChatId, id: data.sourceMessageId },
      },
    });
    if (source?.private !== false || source.senderId !== data.userId)
      throw new Error('Fact source unavailable');
    const existing = await tx.userFact.findFirst({
      where: {
        userId: data.userId,
        content: data.content,
        type: data.type,
        evidence: {
          some: {
            sourceChatId: data.sourceChatId,
            sourceMessageId: data.sourceMessageId,
          },
        },
      },
    });
    if (existing) return existing;
    throwIfUpdateAborted();
    const fact = await tx.userFact.create({
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
    if (data.embedding) await writeFactVector(tx, fact.id, data.embedding);
    return fact;
  });
}

export async function applyUserFactEvidenceRepo(input: {
  factId: bigint;
  content: string;
  sourceChatId: bigint;
  sourceMessageId: bigint;
  reason: 'duplicate' | 'contradiction';
  embedding?: number[];
}): Promise<
  | 'applied'
  | 'already_applied'
  | 'skipped_stale_source'
  | 'skipped_unknown_source_order'
> {
  return prisma.$transaction(async (tx) => {
    const owner = await tx.userFact.findUniqueOrThrow({
      where: { id: input.factId },
    });
    await lockFactUser(tx, owner.userId);
    const fact = await tx.userFact.findUniqueOrThrow({
      where: { id: input.factId },
    });
    throwIfUpdateAborted();
    const source = await tx.message.findUnique({
      where: {
        chatId_id: { chatId: input.sourceChatId, id: input.sourceMessageId },
      },
    });
    if (source?.private !== false || source.senderId !== fact.userId)
      return 'skipped_unknown_source_order';
    if (input.reason === 'contradiction') {
      const existing = await tx.userFactEvidence.findMany({
        where: { factId: input.factId },
        include: { sourceMessage: true },
      });
      if (source?.private !== false || !existing.length)
        return 'skipped_unknown_source_order';
      const newest = existing
        .map((e) => e.sourceMessage)
        .filter((m) => m.private === false)
        .sort(compareSourceOrder)
        .at(-1);
      if (!newest) return 'skipped_unknown_source_order';
      if (compareSourceOrder(source, newest) < 0) return 'skipped_stale_source';
    }
    throwIfUpdateAborted();
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
    if (evidence.count === 0) return 'already_applied';

    throwIfUpdateAborted();
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

    throwIfUpdateAborted();
    await tx.factHistory.create({
      data: {
        factId: input.factId,
        previousContent: fact.content,
        newContent: input.content,
        weightChange: input.reason === 'duplicate' ? 1 : -1,
        reason: input.reason,
      },
    });
    if (input.embedding && input.reason === 'contradiction')
      await writeFactVector(tx, input.factId, input.embedding);
    return 'applied';
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

export function compareSourceOrder(
  a: { sentAt: Date; chatId: bigint; id: bigint },
  b: { sentAt: Date; chatId: bigint; id: bigint },
) {
  return (
    a.sentAt.getTime() - b.sentAt.getTime() ||
    (a.chatId < b.chatId
      ? -1
      : a.chatId > b.chatId
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0)
  );
}
async function lockFactUser(tx: Prisma.TransactionClient, userId: bigint) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`user-fact:${userId}`}, 0))::text`;
  throwIfUpdateAborted();
}
async function writeFactVector(
  tx: Prisma.TransactionClient,
  id: bigint,
  embedding: number[],
) {
  throwIfUpdateAborted();
  if (!embedding.length || !embedding.every(Number.isFinite))
    throw new Error('Invalid fact embedding');
  await tx.$executeRaw`UPDATE "UserFact" SET "embedding" = ${`[${embedding.join(',')}]`}::vector, "embeddingVersion" = ${Number(process.env.EMBEDDING_VERSION || '1')} WHERE "id" = ${id}`;
}
