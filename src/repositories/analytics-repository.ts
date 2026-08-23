import { prisma } from '../db';

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
