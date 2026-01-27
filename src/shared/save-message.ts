import { LRUCache } from 'lru-cache';

import { prisma } from '../db';

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
}

async function findReplyId(
  chatId: bigint,
  replyToMsgId: bigint | undefined,
): Promise<bigint | null> {
  if (!replyToMsgId) return null;

  const exists = await checkMessageExists(chatId, replyToMsgId);
  return exists ? replyToMsgId : null;
}

export const saveMessage = async (params: {
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
}) => {
  const replyId = await findReplyId(
    BigInt(params.chatId),
    params.replyToMessageId ? BigInt(params.replyToMessageId) : undefined,
  );

  return prisma.message.create({
    data: {
      id: BigInt(params.id),
      chatId: BigInt(params.chatId),
      senderId: BigInt(params.senderId),
      replyToMessageId: replyId,
      sentAt: params.sentAt,
      messageType: params.messageType,
      text: params.text,
      media: params.media,
      summary: params.summary,
      sessionId: params.sessionId,
    },
  });
};
