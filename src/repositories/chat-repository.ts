import type { Chat } from '@grammyjs/types';
import { LRUCache } from 'lru-cache';

import { prisma } from '../db';
import { Prisma } from '../generated/prisma/client';
import { handleError } from '../utils/error-handler';

const cache = new LRUCache<number, true>({
  max: 1000,
  ttl: 24 * 60 * 60 * 1000,
  updateAgeOnGet: false,
  updateAgeOnHas: false,
});

export const saveChat = async (
  chat:
    | Chat.PrivateChat
    | Chat.GroupChat
    | Chat.SupergroupChat
    | Chat.ChannelChat,
) => {
  try {
    if (cache.has(chat.id)) {
      return;
    }
    const chatType = chat.type === 'private' ? 'PRIVATE' : 'GROUP';

    const title =
      chat.type === 'private'
        ? [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
          chat.username ||
          chat.id.toString()
        : chat.title;

    await prisma.chat.upsert({
      create: {
        id: chat.id,
        title,
        chatType,
      },
      update: {
        title,
      },
      where: {
        id: chat.id,
      },
    });

    cache.set(chat.id, true);
  } catch (error) {
    handleError(error, `Error saving chat ${chat.id}`);
  }
};

export async function findChatByIdRepo<T extends Prisma.ChatSelect>(
  chatId: bigint,
  select: T,
): Promise<Prisma.ChatGetPayload<{ select: T }> | null> {
  return prisma.chat.findUnique({
    where: { id: chatId },
    select: select as Prisma.ChatSelect,
  }) as Promise<Prisma.ChatGetPayload<{ select: T }> | null>;
}

export async function findGroupChatsRepo() {
  return prisma.chat.findMany({
    where: { chatType: 'GROUP', active: true },
    select: { id: true, title: true },
  });
}

export const findActiveGroupChatsRepo = findGroupChatsRepo;

export async function deactivateChatRepo(
  chatId: bigint,
  inactiveSince = new Date(),
) {
  return prisma.chat.update({
    where: { id: chatId },
    data: { active: false, inactiveSince },
  });
}

export async function reactivateInactiveGroupChatsRepo(): Promise<number> {
  return prisma.$executeRaw(
    Prisma.sql`
    UPDATE "Chat" AS chat
    SET "active" = true, "inactiveSince" = NULL
    WHERE chat."chatType" = 'GROUP'
      AND chat."active" = false
      AND chat."inactiveSince" IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM "Message" AS message
        WHERE message."chatId" = chat."id"
          AND message."sentAt" > chat."inactiveSince"
      )
  `,
  );
}

export async function updateChatRepo(
  chatId: bigint,
  data: Prisma.ChatUpdateInput,
) {
  return prisma.chat.update({
    where: { id: chatId },
    data,
  });
}

export async function upsertChatFeatureRepo(
  chatId: bigint,
  feature: 'selfieSaturday' | 'inktober',
  enabled: boolean,
  chatInfo?: { title: string; chatType: 'PRIVATE' | 'GROUP' },
) {
  const data =
    feature === 'selfieSaturday'
      ? { selfieSaturdayEnabled: enabled }
      : { inktoberEnabled: enabled };

  return prisma.chat.upsert({
    where: { id: chatId },
    update: data,
    create: {
      id: chatId,
      title: chatInfo?.title ?? chatId.toString(),
      chatType: chatInfo?.chatType ?? 'GROUP',
      ...data,
    },
  });
}

export async function findManyChatsRepo(
  where: Prisma.ChatWhereInput,
  options?: {
    select?: Prisma.ChatSelect;
    include?: Prisma.ChatInclude;
  },
) {
  return prisma.chat.findMany({
    where,
    ...options,
  });
}
