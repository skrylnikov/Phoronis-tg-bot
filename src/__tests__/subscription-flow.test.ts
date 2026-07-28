import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma } = vi.hoisted(() => {
  const mockedPrisma = {
    purchaseSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    paymentOrder: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    subscription: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    quotaUsage: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    limitNotice: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { prisma: mockedPrisma };
});

vi.mock('../db', () => ({ prisma }));

import { reserveQuota } from '../shared/quota-service';
import {
  activatePayment,
  createPaymentOrder,
  getInvoicePayload,
  getPurchaseOptions,
  paymentTermsVersion,
  refundPayment,
  validatePaymentOrder,
  weeklyPromotionEndsAt,
} from '../shared/subscriptions';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
  );
  prisma.paymentOrder.count.mockResolvedValue(0);
  prisma.subscription.findMany.mockResolvedValue([]);
  prisma.purchaseSession.deleteMany.mockResolvedValue({ count: 1 });
  prisma.$queryRaw.mockResolvedValue([{ count: 1 }]);
});

describe('subscription purchase flow', () => {
  it('extends from the current end date without revoking active purchases', async () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const currentEndsAt = new Date('2026-08-10T12:00:00.000Z');
    prisma.paymentOrder.findUnique.mockResolvedValue(null);
    prisma.paymentOrder.findFirst.mockResolvedValue({
      id: 'order-1',
      userId: 123n,
      beneficiaryChatId: -100n,
      plan: 'MONTH',
    });
    prisma.subscription.findMany.mockResolvedValue([
      { plan: 'WEEK', endsAt: currentEndsAt },
    ]);
    prisma.subscription.create.mockImplementation(async ({ data }) => ({
      id: 'subscription-2',
      ...data,
    }));
    prisma.paymentOrder.update.mockResolvedValue({});

    const subscription = await activatePayment({
      invoicePayload: getInvoicePayload('order-1'),
      userId: 123,
      currency: 'XTR',
      amount: 99,
      chargeId: 'charge-1',
      now,
    });

    expect(subscription?.endsAt).toEqual(new Date('2026-09-09T12:00:00.000Z'));
    expect(subscription?.activatedNow).toBe(true);
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('does not mark an already processed charge as a new purchase', async () => {
    prisma.paymentOrder.findUnique.mockResolvedValue({
      subscription: { id: 'subscription-1', endsAt: new Date('2026-08-01') },
    });

    const subscription = await activatePayment({
      invoicePayload: getInvoicePayload('order-1'),
      userId: 123,
      currency: 'XTR',
      amount: 99,
      chargeId: 'charge-1',
    });

    expect(subscription?.activatedNow).toBe(false);
    expect(prisma.subscription.create).not.toHaveBeenCalled();
  });

  it('removes refunded days from later purchases without revoking them', async () => {
    const now = new Date('2026-07-29T12:00:00.000Z');
    prisma.paymentOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      userId: 123n,
      plan: 'WEEK',
      status: 'PAID',
      subscriptionId: 'subscription-1',
    });
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'subscription-1',
      endsAt: new Date('2026-08-04T12:00:00.000Z'),
    });
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: 'subscription-2',
        endsAt: new Date('2026-09-03T12:00:00.000Z'),
      },
    ]);
    prisma.paymentOrder.update.mockResolvedValue({});
    prisma.subscription.updateMany.mockResolvedValue({ count: 1 });
    prisma.subscription.update.mockResolvedValue({});

    await refundPayment('charge-1', now);

    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: 'subscription-1', revokedAt: null },
      data: { revokedAt: now },
    });
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'subscription-2' },
      data: { endsAt: new Date('2026-08-27T12:00:00.000Z') },
    });
  });

  it('offers only the active plan or more expensive plans', async () => {
    const now = new Date('2026-08-10T12:00:00.000Z');
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: 'subscription-1',
        plan: 'QUARTER',
        beneficiaryChatId: -100n,
        endsAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ]);

    const options = await getPurchaseOptions(123, now);

    expect(options.map((option) => option.plan)).toEqual(['QUARTER', 'YEAR']);
  });

  it('requires current terms acceptance before creating an order', async () => {
    prisma.purchaseSession.findUnique.mockResolvedValue({
      token: 'session',
      userId: 123n,
      beneficiaryChatId: -100n,
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      termsAcceptedAt: null,
      termsVersion: null,
    });

    await expect(
      createPaymentOrder({
        userId: 123,
        plan: 'WEEK',
        purchaseToken: 'session',
        now: new Date('2026-07-28T12:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'TERMS_NOT_ACCEPTED',
    });
  });

  it('expires a promotional order no later than the promotion', async () => {
    const now = new Date('2026-08-02T20:50:00.000Z');
    const acceptedAt = new Date('2026-08-02T20:49:00.000Z');
    prisma.purchaseSession.findUnique.mockResolvedValue({
      token: 'session',
      userId: 123n,
      beneficiaryChatId: -100n,
      expiresAt: new Date('2026-08-02T21:20:00.000Z'),
      termsAcceptedAt: acceptedAt,
      termsVersion: paymentTermsVersion,
    });
    prisma.paymentOrder.create.mockImplementation(async ({ data }) => ({
      id: 'order-1',
      ...data,
    }));

    const order = await createPaymentOrder({
      userId: 123,
      plan: 'WEEK',
      purchaseToken: 'session',
      now,
    });

    expect(order.expiresAt).toEqual(weeklyPromotionEndsAt);
    expect(order.termsAcceptedAt).toEqual(acceptedAt);
    expect(order.termsVersion).toBe(paymentTermsVersion);
  });

  it('rejects and expires stale orders during pre-checkout', async () => {
    const now = new Date('2026-08-03T00:00:00.000Z');
    prisma.paymentOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      status: 'PENDING',
      userId: 123n,
      amount: 29,
      expiresAt: new Date('2026-08-02T21:00:00.000Z'),
    });
    prisma.paymentOrder.updateMany.mockResolvedValue({ count: 1 });

    const order = await validatePaymentOrder({
      invoicePayload: getInvoicePayload('order-1'),
      userId: 123,
      currency: 'XTR',
      amount: 29,
      now,
    });

    expect(order).toBeNull();
    expect(prisma.paymentOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
  });
});

describe('cumulative quotas', () => {
  it('adds daily limits from all active purchases', async () => {
    prisma.subscription.findMany.mockResolvedValue([
      { plan: 'WEEK' },
      { plan: 'MONTH' },
    ]);

    const reservation = await reserveQuota({
      userId: 123,
      chatId: -100,
      isGroup: false,
      kind: 'PRIMARY_RESPONSE',
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    expect(reservation.allowed).toBe(true);
    const query = prisma.$queryRaw.mock.calls[0]?.[0] as {
      values: unknown[];
    };
    expect(query.values.at(-1)).toBe(35);
  });
});
