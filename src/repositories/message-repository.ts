import type { Message as GrammyMessage } from '@grammyjs/types';
import { LRUCache } from 'lru-cache';

import { prisma } from '../db';
import { handleError } from '../utils/error-handler';

const cache = new LRUCache<string, true>({
  max: 10000,
  ttl: 60 * 60 * 1000,
  updateAgeOnGet: false,
  updateAgeOnHas: false,
});

export interface SaveMessageParams {
  id: bigint;
  chatId: bigint;
  text?: string;
  caption?: string;
  private?: boolean;
  summary?: string;
  sentAt: Date;
  senderId: bigint;
  media?: string | null;
  replyToMessageId?: bigint;
}

export const saveMessage = async (message: SaveMessageParams) => {
  try {
    const cacheKey = `${message.chatId}:${message.id}`;
    if (cache.has(cacheKey)) {
      return;
    }

    const isReply = !!message.replyToMessageId;

    await prisma.message.upsert({
      create: {
        id: message.id,
        chatId: message.chatId,
        senderId: message.senderId,
        sentAt: message.sentAt,
        text: message.text ?? message.caption ?? null,
        summary: message.summary ?? null,
        private: message.private ?? false,
        media: message.media ?? null,
        ...(isReply
          ? {
              replyToMessage: {
                connect: {
                  chatId_id: {
                    chatId: message.chatId,
                    id: message.replyToMessageId!,
                  },
                },
              },
            }
          : {}),
      },
      update: {
        senderId: message.senderId,
        sentAt: message.sentAt,
        text: message.text ?? message.caption ?? null,
        summary: message.summary ?? null,
        private: message.private ?? false,
        media: message.media ?? null,
        ...(isReply
          ? {
              replyToMessage: {
                connect: {
                  chatId_id: {
                    chatId: message.chatId,
                    id: message.replyToMessageId!,
                  },
                },
              },
            }
          : {}),
      },
      where: {
        chatId_id: {
          chatId: message.chatId,
          id: message.id,
        },
      },
    });

    cache.set(cacheKey, true);
  } catch (error) {
    handleError(error, `Error saving message ${message.id}`);
  }
};

export async function countMessagesRepo(where: {
  chatId: bigint;
  senderId: bigint;
  private: boolean;
}) {
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

export async function findMessageByIdRepo(
  chatId: bigint,
  messageId: bigint,
) {
  return prisma.message.findUnique({
    where: {
      chatId_id: { chatId, id: messageId },
    },
  });
}
