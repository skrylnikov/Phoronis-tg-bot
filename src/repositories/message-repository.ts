import { LRUCache } from 'lru-cache';

import { prisma } from '../db';
import type { MessageType, Prisma } from '../generated/prisma/client';
import { handleError } from '../utils/error-handler';

const cache = new LRUCache<string, true>({
  max: 10000,
  ttl: 60 * 60 * 1000,
  updateAgeOnGet: false,
  updateAgeOnHas: false,
});

async function checkMessageExistsRepo(
  chatId: bigint,
  messageId: bigint,
): Promise<boolean> {
  try {
    const message = await prisma.message.findUnique({
      where: {
        chatId_id: {
          chatId,
          id: messageId,
        },
      },
      select: {
        id: true,
      },
    });
    return message !== null;
  } catch (error) {
    handleError(
      error,
      `Error checking message existence ${chatId}_${messageId}`,
    );
    return false;
  }
}

async function findReplyIdRepo(
  chatId: bigint,
  replyToMessageId: bigint | undefined,
): Promise<bigint | null> {
  if (!replyToMessageId) return null;

  try {
    const exists = await checkMessageExistsRepo(chatId, replyToMessageId);
    return exists ? replyToMessageId : null;
  } catch (error) {
    handleError(
      error,
      `Error finding reply ID for ${chatId}_${replyToMessageId}`,
    );
    return null;
  }
}

export interface SaveMessageParams {
  id: bigint;
  chatId: bigint;
  text?: string;
  caption?: string;
  private?: boolean;
  summary?: string;
  sentAt: Date;
  senderId: bigint;
  sessionId?: string | null;
  media?: string | null;
  replyToMessageId?: bigint;
  messageType?: string;
  modelId?: string | null;
}

export const saveMessage = async (
  message: SaveMessageParams,
): Promise<{ created: boolean }> => {
  const cacheKey = `${message.chatId}:${message.id}`;
  if (cache.has(cacheKey)) {
    return { created: false };
  }

  try {
    const replyId = await findReplyIdRepo(
      message.chatId,
      message.replyToMessageId,
    );

    await prisma.message.create({
      data: {
        id: message.id,
        chatId: message.chatId,
        senderId: message.senderId,
        sessionId: message.sessionId ?? null,
        sentAt: message.sentAt,
        text: message.text ?? message.caption ?? null,
        summary: message.summary ?? null,
        private: message.private ?? false,
        media: message.media ?? null,
        replyToMessageId: replyId,
        messageType: (message.messageType ?? 'TEXT') as MessageType,
        modelId: message.modelId ?? null,
      },
    });

    cache.set(cacheKey, true);
    return { created: true };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'P2002'
    ) {
      cache.set(cacheKey, true);
      return { created: false };
    }
    handleError(error, `Error saving message ${message.id}`);
    throw error;
  }
};

export async function countMessagesRepo(
  where: Prisma.MessageWhereInput,
): Promise<number> {
  return prisma.message.count({ where });
}

export async function findMessagesRepo(where: {
  chatId: bigint;
  senderId: bigint;
  private: boolean;
}) {
  return prisma.message.findMany({
    where,
    include: { replyToMessage: true },
    orderBy: { sentAt: 'desc' },
    take: 30,
  });
}

export async function findMessageByIdRepo(chatId: bigint, messageId: bigint) {
  return prisma.message.findUnique({
    where: {
      chatId_id: { chatId, id: messageId },
    },
  });
}

export async function findMessageWithSelectRepo<T extends Prisma.MessageSelect>(
  chatId: bigint,
  messageId: bigint,
  select: T,
) {
  return prisma.message.findUnique({
    where: { chatId_id: { chatId, id: messageId } },
    select,
  });
}

export async function updateMessageSummaryRepo(
  chatId: bigint,
  messageId: bigint,
  summary: string,
) {
  return prisma.message.update({
    where: { chatId_id: { chatId, id: messageId } },
    data: { summary },
  });
}

export async function updateMessageFieldsRepo(
  chatId: bigint,
  messageId: bigint,
  data: Prisma.MessageUpdateInput,
) {
  return prisma.message.update({
    where: { chatId_id: { chatId, id: messageId } },
    data,
  });
}

export async function updateMessageManyRepo(
  where: Prisma.MessageWhereInput,
  data: Prisma.MessageUpdateManyMutationInput,
) {
  return prisma.message.updateMany({ where, data });
}

export async function countMessagesWithWhereRepo(
  where: Prisma.MessageWhereInput,
) {
  return prisma.message.count({ where });
}

export interface MessageStatsByChat {
  botReplies: number;
  recognizedVoices: number;
}

export async function countMessageStatsByChatRepo(
  chatIds: readonly bigint[],
  botUserId: bigint,
): Promise<Map<bigint, MessageStatsByChat>> {
  const stats = new Map<bigint, MessageStatsByChat>(
    chatIds.map((chatId) => [chatId, { botReplies: 0, recognizedVoices: 0 }]),
  );
  if (chatIds.length === 0) return stats;

  const [botReplies, recognizedVoices] = await Promise.all([
    prisma.message.groupBy({
      by: ['chatId'],
      where: {
        chatId: { in: [...chatIds] },
        senderId: botUserId,
        replyToMessageId: { not: null },
      },
      _count: { _all: true },
    }),
    prisma.message.groupBy({
      by: ['chatId'],
      where: {
        chatId: { in: [...chatIds] },
        messageType: 'VOICE',
        senderId: { not: botUserId },
      },
      _count: { _all: true },
    }),
  ]);

  for (const row of botReplies) {
    const chatStats = stats.get(row.chatId);
    if (chatStats) chatStats.botReplies = row._count._all;
  }
  for (const row of recognizedVoices) {
    const chatStats = stats.get(row.chatId);
    if (chatStats) chatStats.recognizedVoices = row._count._all;
  }

  return stats;
}

export async function findManyMessagesRepo(
  where: Prisma.MessageWhereInput,
  options?: {
    include?: Prisma.MessageInclude;
    select?: Prisma.MessageSelect;
    orderBy?:
      | Prisma.MessageOrderByWithRelationInput
      | Prisma.MessageOrderByWithRelationInput[];
    take?: number;
    skip?: number;
  },
) {
  return prisma.message.findMany({
    where,
    ...options,
  });
}

export async function findFirstMessageRepo(
  where: Prisma.MessageWhereInput,
  options?: {
    include?: Prisma.MessageInclude;
    select?: Prisma.MessageSelect;
    orderBy?:
      | Prisma.MessageOrderByWithRelationInput
      | Prisma.MessageOrderByWithRelationInput[];
  },
) {
  return prisma.message.findFirst({
    where,
    ...options,
  });
}
export async function deleteOldPrivateMessagesRepo(): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await prisma.message.deleteMany({
    where: { private: true, sentAt: { lt: sevenDaysAgo } },
  });
  return result.count;
}
