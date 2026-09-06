import { prisma } from '../db';
import {
  aggregateAlias,
  minimumAliasConfidence,
  normalizeAlias,
  validateAlias,
} from '../domain/user/aliases';
import type { Prisma } from '../generated/prisma/client';

const evidenceInclude = {
  evidence: { include: { sourceMessage: true } },
} as const;

async function lockOwner(
  tx: Prisma.TransactionClient,
  chatId: bigint,
  userId: bigint,
) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`user-alias:${chatId}:${userId}`}, 0))::text`;
}

export async function findUserAliasesRepo(chatId: bigint, userId?: bigint) {
  const rows = await prisma.userAlias.findMany({
    where: { chatId, userId },
    include: evidenceInclude,
  });
  // ponytail: recalculate the small chat dictionary on read; batch aggregates if it grows large.
  return rows.map(({ evidence, ...row }) => ({
    ...row,
    ...aggregateAlias(evidence, row.ownerConfirmed, row.status === 'REJECTED'),
  }));
}

export async function saveUserAliasEvidenceRepo(input: {
  chatId: bigint;
  userId: bigint;
  alias: string;
  sourceMessageId: bigint;
  modelConfidence: number;
  neutralForAddressing: boolean;
  botId: bigint;
}) {
  const name = validateAlias(input.alias);
  if (
    !name ||
    !Number.isFinite(input.modelConfidence) ||
    input.modelConfidence < minimumAliasConfidence ||
    input.modelConfidence > 1 ||
    input.userId === input.botId
  )
    return false;
  return prisma.$transaction(async (tx) => {
    await lockOwner(tx, input.chatId, input.userId);
    const source = await tx.message.findUnique({
      where: { chatId_id: { chatId: input.chatId, id: input.sourceMessageId } },
      include: { replyToMessage: true },
    });
    if (
      source?.private !== false ||
      source.senderId === input.botId ||
      !normalizeAlias(source.text ?? '').includes(name.normalizedAlias)
    )
      return false;
    if (
      source.senderId !== input.userId &&
      !(
        source.replyToMessage?.private === false &&
        source.replyToMessage.senderId === input.userId
      )
    )
      return false;
    const row = await tx.userAlias.upsert({
      where: {
        chatId_userId_normalizedAlias: {
          chatId: input.chatId,
          userId: input.userId,
          normalizedAlias: name.normalizedAlias,
        },
      },
      create: { chatId: input.chatId, userId: input.userId, ...name },
      update: {},
    });
    await tx.userAliasEvidence.createMany({
      data: {
        aliasId: row.id,
        sourceChatId: input.chatId,
        sourceMessageId: input.sourceMessageId,
        modelConfidence: input.modelConfidence,
        neutralForAddressing: input.neutralForAddressing,
      },
      skipDuplicates: true,
    });
    const evidence = await tx.userAliasEvidence.findMany({
      where: { aliasId: row.id },
      include: { sourceMessage: true },
    });
    const { confidence, confirmationCount, status } = aggregateAlias(
      evidence,
      row.ownerConfirmed,
      row.status === 'REJECTED',
    );
    await tx.userAlias.update({
      where: { id: row.id },
      data: { confidence, confirmationCount, status },
    });
    return true;
  });
}

export async function setMyAliasRepo(input: {
  chatId: bigint;
  userId: bigint;
  messageId: bigint;
  alias: string;
  action: 'prefer' | 'avoid_addressing' | 'reject_identity';
}) {
  const name = validateAlias(input.alias);
  if (!name) throw new Error('Недопустимый псевдоним');
  return prisma.$transaction(async (tx) => {
    await lockOwner(tx, input.chatId, input.userId);
    const latest = await tx.userAlias.findFirst({
      where: {
        chatId: input.chatId,
        userId: input.userId,
        lastOwnerMessageId: { not: null },
      },
      orderBy: { lastOwnerMessageId: 'desc' },
    });
    if (
      latest?.lastOwnerMessageId !== null &&
      latest?.lastOwnerMessageId !== undefined &&
      latest.lastOwnerMessageId >= input.messageId
    )
      return false;
    if (input.action === 'prefer')
      await tx.userAlias.updateMany({
        where: { chatId: input.chatId, userId: input.userId, preferred: true },
        data: { preferred: false },
      });
    const overrides =
      input.action === 'prefer'
        ? {
            preferred: true,
            ownerConfirmed: true,
            addressingBlocked: false,
            status: 'CONFIRMED' as const,
            confidence: 1,
          }
        : input.action === 'reject_identity'
          ? {
              preferred: false,
              ownerConfirmed: false,
              addressingBlocked: true,
              status: 'REJECTED' as const,
              confidence: 0,
            }
          : { preferred: false, addressingBlocked: true };
    await tx.userAlias.upsert({
      where: {
        chatId_userId_normalizedAlias: {
          chatId: input.chatId,
          userId: input.userId,
          normalizedAlias: name.normalizedAlias,
        },
      },
      create: {
        chatId: input.chatId,
        userId: input.userId,
        ...name,
        ...overrides,
        lastOwnerMessageId: input.messageId,
      },
      update: { ...name, ...overrides, lastOwnerMessageId: input.messageId },
    });
    return true;
  });
}
