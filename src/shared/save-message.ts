import { LRUCache } from 'lru-cache';

import { prisma } from '../db';
import { type Message, Prisma } from '../generated/prisma/client';
import { logger } from '../logger';
import { handleError } from '../utils/error-handler';

const messageCache = new LRUCache<string, boolean>({
  max: 10000,
  ttl: 24 * 60 * 60 * 1000,
  updateAgeOnGet: false,
  updateAgeOnHas: false,
});

async function checkMessageExists(
  chatId: bigint,
  messageId: bigint,
): Promise<boolean> {
  const key = `${chatId}_${messageId}`;

  if (messageCache.has(key)) {
    return messageCache.get(key) || false;
  }

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

    const exists = message !== null;
    messageCache.set(key, exists);
    return exists;
  } catch (error) {
    handleError(
      error,
      `Error checking message existence ${chatId}_${messageId}`,
    );
    return false;
  }
}

async function findReplyId(
  chatId: bigint,
  replyToMsgId: bigint | undefined,
): Promise<bigint | null> {
  if (!replyToMsgId) return null;

  try {
    const exists = await checkMessageExists(chatId, replyToMsgId);
    return exists ? replyToMsgId : null;
  } catch (error) {
    handleError(error, `Error finding reply ID for ${chatId}_${replyToMsgId}`);
    return null;
  }
}

export interface SaveMessageResult {
  message: Message;
  created: boolean;
}

export type SaveMessageParams = {
  id: number | bigint;
  chatId: number | bigint;
  senderId: number | bigint;
  sentAt: Date;
  messageType: 'TEXT' | 'MEDIA' | 'VOICE';
  replyToMessageId?: number | bigint | undefined;
  text?: string | null;
  media?: string | null;
  summary?: string | null;
  sessionId?: string | null;
  private?: boolean | null;
};

function isDuplicateMessageError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

export const saveMessageIfAbsent = async (
  params: SaveMessageParams,
): Promise<SaveMessageResult> => {
  const chatId = BigInt(params.chatId);
  const messageId = BigInt(params.id);

  try {
    const replyId = await findReplyId(
      chatId,
      params.replyToMessageId ? BigInt(params.replyToMessageId) : undefined,
    );

    const message = await prisma.message.create({
      data: {
        id: messageId,
        chatId,
        senderId: BigInt(params.senderId),
        replyToMessageId: replyId,
        sentAt: params.sentAt,
        messageType: params.messageType,
        text: params.text,
        media: params.media,
        summary: params.summary,
        sessionId: params.sessionId,
        private: params.private,
      },
    });

    messageCache.set(`${chatId}_${messageId}`, true);
    return { message, created: true };
  } catch (error) {
    if (isDuplicateMessageError(error)) {
      const existing = await prisma.message.findUnique({
        where: { chatId_id: { chatId, id: messageId } },
      });
      if (existing) {
        messageCache.set(`${chatId}_${messageId}`, true);
        logger.info(
          {
            event: 'message.duplicate_ignored',
            chatId: Number(chatId),
            messageId: Number(messageId),
          },
          'Duplicate message persistence ignored',
        );
        return { message: existing, created: false };
      }
    }
    handleError(error, `Error saving message ${params.id}`);
    throw error;
  }
};

export const saveMessage = async (
  params: SaveMessageParams,
): Promise<Message> => {
  const result = await saveMessageIfAbsent(params);
  return result.message;
};
