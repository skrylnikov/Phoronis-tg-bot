import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    chat: { findUnique: vi.fn() },
    dailyAnalytics: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    message: { count: vi.fn() },
    quotaUsage: { groupBy: vi.fn() },
    paymentOrder: { aggregate: vi.fn() },
    subscription: { count: vi.fn() },
  },
}));

vi.mock('../config', () => ({ analyticsChatId: 777 }));
vi.mock('../db', () => ({ prisma }));
vi.mock('../shared/quota-service', () => ({
  MOSCOW_TIME_ZONE: 'Europe/Moscow',
  getMoscowDay: () => new Date('2026-07-28T00:00:00.000Z'),
}));
vi.mock('../shared/subscriptions', () => ({
  getPlanTitle: () => '1 месяц',
}));

import {
  sendDailyAnalyticsReport,
  sendPurchaseNotification,
} from '../analytics';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.dailyAnalytics.findUnique.mockResolvedValue(null);
  prisma.message.count.mockResolvedValue(42);
  prisma.quotaUsage.groupBy.mockResolvedValue([
    { kind: 'IMAGE', _sum: { count: 5 } },
    { kind: 'VOICE', _sum: { count: 3 } },
    { kind: 'PRIMARY_RESPONSE', _sum: { count: 17 } },
  ]);
  prisma.paymentOrder.aggregate
    .mockResolvedValueOnce({ _count: { _all: 2 }, _sum: { amount: 148 } })
    .mockResolvedValueOnce({ _count: { _all: 1 }, _sum: { amount: 49 } });
  prisma.subscription.count.mockResolvedValue(7);
  prisma.dailyAnalytics.upsert.mockResolvedValue({});
  prisma.dailyAnalytics.update.mockResolvedValue({});
});

describe('analytics notifications', () => {
  it('sends the report once after 23:00 Moscow time', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});

    const sent = await sendDailyAnalyticsReport(
      { sendMessage } as never,
      new Date('2026-07-28T20:00:00.000Z'),
    );

    expect(sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      777,
      expect.stringContaining('Сообщений в базе: 42'),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      777,
      expect.stringContaining('Покупок: 2 на 148 ⭐'),
    );
    expect(prisma.dailyAnalytics.update).toHaveBeenCalledWith({
      where: { date: new Date('2026-07-28T00:00:00.000Z') },
      data: { reportSentAt: new Date('2026-07-28T20:00:00.000Z') },
    });
  });

  it('does not send a duplicate daily report', async () => {
    prisma.dailyAnalytics.findUnique.mockResolvedValue({
      reportSentAt: new Date('2026-07-28T20:00:00.000Z'),
    });
    const sendMessage = vi.fn();

    const sent = await sendDailyAnalyticsReport(
      { sendMessage } as never,
      new Date('2026-07-28T20:00:00.000Z'),
    );

    expect(sent).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('identifies the buyer, beneficiary chat, plan, and Stars amount', async () => {
    prisma.chat.findUnique.mockResolvedValue({ title: 'Клуб Ио' });
    const sendMessage = vi.fn().mockResolvedValue({});

    await sendPurchaseNotification({
      api: { sendMessage } as never,
      buyer: { first_name: 'Иван', last_name: 'Иванов', username: 'ivan' },
      beneficiaryChatId: -100n,
      plan: 'MONTH',
      amount: 99,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      777,
      [
        'Новая подписка',
        'Покупатель: Иван Иванов (@ivan)',
        'Чат: Клуб Ио',
        'Тариф: 1 месяц',
        'Сумма: 99 ⭐',
      ].join('\n'),
    );
  });
});
