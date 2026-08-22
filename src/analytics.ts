import type { User } from '@grammyjs/types';
import type { Api } from 'grammy';
import { analyticsChatId } from './config';
import { prisma } from './db';
import { getMoscowDay, MOSCOW_TIME_ZONE } from './domain/quota-service';
import { getPlanTitle } from './domain/subscriptions';
import type { SubscriptionPlan } from './generated/prisma/client';

const moscowOffsetMs = 3 * 60 * 60 * 1000;

function getMoscowDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
  };
}

function getMoscowDayRange(date: Date): { start: Date; end: Date } {
  const { year, month, day } = getMoscowDateParts(date);
  const start = new Date(Date.UTC(year, month - 1, day) - moscowOffsetMs);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function formatBuyer(
  buyer: Pick<User, 'first_name' | 'last_name' | 'username'>,
): string {
  const name = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ');
  return buyer.username
    ? `${name || 'Пользователь'} (@${buyer.username})`
    : name || 'Пользователь без username';
}

export async function sendPurchaseNotification(input: {
  api: Api;
  buyer: Pick<User, 'first_name' | 'last_name' | 'username'>;
  beneficiaryChatId: bigint;
  plan: SubscriptionPlan;
  amount: number;
}): Promise<void> {
  const chat = await prisma.chat.findUnique({
    where: { id: input.beneficiaryChatId },
    select: { title: true },
  });
  await input.api.sendMessage(
    analyticsChatId,
    [
      'Новая подписка',
      `Покупатель: ${formatBuyer(input.buyer)}`,
      `Чат: ${chat?.title ?? input.beneficiaryChatId.toString()}`,
      `Тариф: ${getPlanTitle(input.plan)}`,
      `Сумма: ${input.amount} ⭐`,
    ].join('\n'),
  );
}

export async function sendDailyAnalyticsReport(
  api: Api,
  now = new Date(),
): Promise<boolean> {
  const dateParts = getMoscowDateParts(now);
  if (dateParts.hour < 23) return false;

  const day = getMoscowDay(now);
  const existing = await prisma.dailyAnalytics.findUnique({
    where: { date: day },
    select: { reportSentAt: true },
  });
  if (existing?.reportSentAt) return false;
  await prisma.dailyAnalytics.upsert({
    where: { date: day },
    create: { date: day },
    update: {},
  });

  const { start, end } = getMoscowDayRange(now);
  const [messageCount, usages, paid, refunded, activeSubscriptions] =
    await Promise.all([
      prisma.message.count({ where: { sentAt: { gte: start, lt: end } } }),
      prisma.quotaUsage.groupBy({
        by: ['kind'],
        where: { date: day },
        _sum: { count: true },
      }),
      prisma.paymentOrder.aggregate({
        where: { status: 'PAID', paidAt: { gte: start, lt: end } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.paymentOrder.aggregate({
        where: { status: 'REFUNDED', refundedAt: { gte: start, lt: end } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.subscription.count({
        where: { startsAt: { lte: now }, endsAt: { gt: now }, revokedAt: null },
      }),
    ]);
  const used = (kind: 'PRIMARY_RESPONSE' | 'IMAGE' | 'VOICE') =>
    usages.find((usage) => usage.kind === kind)?._sum.count ?? 0;
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: MOSCOW_TIME_ZONE,
    day: 'numeric',
    month: 'long',
  }).format(now);

  await api.sendMessage(
    analyticsChatId,
    [
      `Статистика Phoronis за ${date} (до 23:00 МСК)`,
      `• Сообщений в базе: ${messageCount}`,
      `• Распознано изображений: ${used('IMAGE')}`,
      `• Распознано голосовых: ${used('VOICE')}`,
      `• ИИ-ответов: ${used('PRIMARY_RESPONSE')}`,
      `• Покупок: ${paid._count._all} на ${paid._sum.amount ?? 0} ⭐`,
      `• Возвратов: ${refunded._count._all} на ${refunded._sum.amount ?? 0} ⭐`,
      `• Активных подписок сейчас: ${activeSubscriptions}`,
    ].join('\n'),
  );
  await prisma.dailyAnalytics.update({
    where: { date: day },
    data: { reportSentAt: now },
  });
  return true;
}
