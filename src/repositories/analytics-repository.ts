import { prisma } from '../db';

export interface AnalyticsMessageActivity {
  incomingMessages: number;
  seenChats: number;
  seenUsers: number;
  answeredMessages: number;
  answeredChats: number;
  answeredUsers: number;
  incomingByChatType: { private: number; group: number };
  answeredByChatType: { private: number; group: number };
  incomingMessagesByChatType: { private: number; group: number };
  answeredMessagesByChatType: { private: number; group: number };
}

export async function findChatById(chatId: bigint) {
  return prisma.chat.findUnique({
    where: { id: chatId },
    select: { title: true },
  });
}

export async function findDailyAnalytics(date: Date) {
  return prisma.dailyAnalytics.findUnique({
    where: { date },
    select: { reportSentAt: true },
  });
}

export async function upsertDailyAnalytics(date: Date) {
  return prisma.dailyAnalytics.upsert({
    where: { date },
    create: { date },
    update: {},
  });
}

export async function updateDailyAnalyticsReportSent(date: Date, now: Date) {
  return prisma.dailyAnalytics.update({
    where: { date },
    data: { reportSentAt: now },
  });
}

export async function countMessagesInRange(start: Date, end: Date) {
  return prisma.message.count({
    where: { sentAt: { gte: start, lt: end } },
  });
}

export async function findMessageActivityInRange(
  start: Date,
  end: Date,
  botUserId: bigint,
): Promise<AnalyticsMessageActivity> {
  const [incoming, botReplies] = await Promise.all([
    prisma.message.findMany({
      where: {
        sentAt: { gte: start, lt: end },
        senderId: { not: botUserId },
      },
      select: {
        chatId: true,
        senderId: true,
        chat: { select: { chatType: true } },
      },
    }),
    prisma.message.findMany({
      where: {
        sentAt: { gte: start, lt: end },
        senderId: botUserId,
        replyToMessageId: { not: null },
      },
      select: {
        chatId: true,
        replyToMessage: {
          select: {
            senderId: true,
            chat: { select: { chatType: true } },
          },
        },
      },
    }),
  ]);

  const incomingChats = new Set<bigint>();
  const incomingUsers = new Set<bigint>();
  const answeredChats = new Set<bigint>();
  const answeredUsers = new Set<bigint>();
  const incomingChatsByChatType = {
    private: new Set<bigint>(),
    group: new Set<bigint>(),
  };
  const answeredChatsByChatType = {
    private: new Set<bigint>(),
    group: new Set<bigint>(),
  };
  const incomingMessagesByChatType = { private: 0, group: 0 };
  const answeredMessagesByChatType = { private: 0, group: 0 };

  for (const message of incoming) {
    incomingChats.add(message.chatId);
    incomingUsers.add(message.senderId);
    const chatType = message.chat.chatType === 'PRIVATE' ? 'private' : 'group';
    incomingChatsByChatType[chatType].add(message.chatId);
    incomingMessagesByChatType[chatType] += 1;
  }

  let answeredMessages = 0;
  for (const message of botReplies) {
    const parent = message.replyToMessage;
    if (!parent || parent.senderId === botUserId) continue;
    answeredMessages += 1;
    answeredChats.add(message.chatId);
    answeredUsers.add(parent.senderId);
    const chatType = parent.chat.chatType === 'PRIVATE' ? 'private' : 'group';
    answeredChatsByChatType[chatType].add(message.chatId);
    answeredMessagesByChatType[chatType] += 1;
  }

  return {
    incomingMessages: incoming.length,
    seenChats: incomingChats.size,
    seenUsers: incomingUsers.size,
    answeredMessages,
    answeredChats: answeredChats.size,
    answeredUsers: answeredUsers.size,
    incomingByChatType: {
      private: incomingChatsByChatType.private.size,
      group: incomingChatsByChatType.group.size,
    },
    answeredByChatType: {
      private: answeredChatsByChatType.private.size,
      group: answeredChatsByChatType.group.size,
    },
    incomingMessagesByChatType,
    answeredMessagesByChatType,
  };
}

export async function findModelIdsInRange(
  start: Date,
  end: Date,
  botUserId: bigint,
): Promise<string[]> {
  const messages = await prisma.message.findMany({
    where: {
      sentAt: { gte: start, lt: end },
      senderId: botUserId,
      replyToMessageId: { not: null },
      modelId: { not: null },
    },
    select: { modelId: true },
  });
  return messages.flatMap((message) =>
    message.modelId ? [message.modelId] : [],
  );
}

export async function countUserFactsInRange(start: Date, end: Date) {
  return prisma.userFact.count({
    where: { createdAt: { gte: start, lt: end } },
  });
}

export async function groupQuotaUsageByKind(date: Date) {
  return prisma.quotaUsage.groupBy({
    by: ['kind'],
    where: { date },
    _sum: { count: true },
  });
}

export async function aggregatePaidOrders(start: Date, end: Date) {
  return prisma.paymentOrder.aggregate({
    where: { status: 'PAID', paidAt: { gte: start, lt: end } },
    _count: { _all: true },
    _sum: { amount: true },
  });
}

export async function aggregateRefundedOrders(start: Date, end: Date) {
  return prisma.paymentOrder.aggregate({
    where: { status: 'REFUNDED', refundedAt: { gte: start, lt: end } },
    _count: { _all: true },
    _sum: { amount: true },
  });
}

export async function countActiveSubscriptions(now: Date) {
  return prisma.subscription.count({
    where: {
      startsAt: { lte: now },
      endsAt: { gt: now },
      revokedAt: null,
    },
  });
}
