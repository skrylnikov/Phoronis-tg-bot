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
    backgroundJob: {
      upsert: vi.fn(),
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

import {
  getQuotaOverview,
  releaseQuota,
  reserveQuota,
} from '../domain/quota-service';
import {
  activatePayment,
  augustPromotionEndsAt,
  createPaymentOrder,
  getInvoicePayload,
  getPurchaseOptions,
  paymentTermsVersion,
  refundPayment,
  validatePaymentOrder,
} from '../domain/subscriptions';

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
    expect(
      prisma.backgroundJob.upsert.mock.calls.map(
        ([call]) => call.where.dedupeKey,
      ),
    ).toEqual([
      'payment-order:order-1:buyer',
      'payment-order:order-1:beneficiary',
      'payment-order:order-1:analytics',
    ]);
  });

  it('does not mark an already processed charge as a new purchase', async () => {
    prisma.paymentOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      userId: 123n,
      beneficiaryChatId: -100n,
      plan: 'WEEK',
      amount: 99,
      subscription: { id: 'subscription-1', endsAt: new Date('2026-08-01') },
    });
    prisma.paymentOrder.findFirst.mockResolvedValue(null);

    const subscription = await activatePayment({
      invoicePayload: getInvoicePayload('order-1'),
      userId: 123,
      currency: 'XTR',
      amount: 99,
      chargeId: 'charge-1',
    });

    expect(subscription?.activatedNow).toBe(false);
    expect(prisma.subscription.create).not.toHaveBeenCalled();
    expect(prisma.backgroundJob.upsert).toHaveBeenCalledTimes(3);
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
    const now = new Date('2026-08-31T20:45:00.000Z');
    const acceptedAt = new Date('2026-08-31T20:44:00.000Z');
    prisma.purchaseSession.findUnique.mockResolvedValue({
      token: 'session',
      userId: 123n,
      beneficiaryChatId: -100n,
      expiresAt: new Date('2026-08-31T21:15:00.000Z'),
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

    expect(order.expiresAt).toEqual(augustPromotionEndsAt);
    expect(order.termsAcceptedAt).toEqual(acceptedAt);
    expect(order.termsVersion).toBe(paymentTermsVersion);
  });

  it('rejects and expires stale orders during pre-checkout', async () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    prisma.paymentOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      status: 'PENDING',
      userId: 123n,
      amount: 39,
      expiresAt: new Date('2026-08-31T20:59:59.999Z'),
    });
    prisma.paymentOrder.updateMany.mockResolvedValue({ count: 1 });

    const order = await validatePaymentOrder({
      invoicePayload: getInvoicePayload('order-1'),
      userId: 123,
      currency: 'XTR',
      amount: 39,
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
    expect(query.values.at(-1)).toBe(80);
  });

  it('gives every group member the full combined group quota', async () => {
    prisma.subscription.findMany.mockResolvedValue([
      { plan: 'WEEK' },
      { plan: 'MONTH' },
    ]);

    await reserveQuota({
      userId: 123,
      chatId: -100,
      isGroup: true,
      kind: 'PRIMARY_RESPONSE',
      now: new Date('2026-07-28T12:00:00.000Z'),
    });
    await reserveQuota({
      userId: 456,
      chatId: -100,
      isGroup: true,
      kind: 'PRIMARY_RESPONSE',
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    const firstQuery = prisma.$queryRaw.mock.calls[0]?.[0] as {
      values: unknown[];
    };
    const secondQuery = prisma.$queryRaw.mock.calls[1]?.[0] as {
      values: unknown[];
    };
    expect(firstQuery.values).toEqual(
      expect.arrayContaining(['CHAT', 123n, -100n, 'PRIMARY_RESPONSE', 8]),
    );
    expect(secondQuery.values).toEqual(
      expect.arrayContaining(['CHAT', 456n, -100n, 'PRIMARY_RESPONSE', 8]),
    );
  });

  it('falls back to the personal quota after a group quota is exhausted', async () => {
    prisma.subscription.findMany
      .mockResolvedValueOnce([{ plan: 'WEEK' }])
      .mockResolvedValueOnce([{ plan: 'WEEK' }]);
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 1 }]);

    const reservation = await reserveQuota({
      userId: 123,
      chatId: -100,
      isGroup: true,
      kind: 'PRIMARY_RESPONSE',
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    expect(reservation).toMatchObject({
      allowed: true,
      source: 'USER',
      ownerId: 123n,
      chatId: 0n,
    });
    const personalQuery = prisma.$queryRaw.mock.calls[1]?.[0] as {
      values: unknown[];
    };
    expect(personalQuery.values).toEqual(
      expect.arrayContaining(['USER', 123n, 0n, 'PRIMARY_RESPONSE', 30]),
    );
  });

  it('releases the exact user and group reservation after an error', async () => {
    prisma.subscription.findMany.mockResolvedValue([{ plan: 'WEEK' }]);

    const reservation = await reserveQuota({
      userId: 123,
      chatId: -100,
      isGroup: true,
      kind: 'IMAGE',
      now: new Date('2026-07-28T12:00:00.000Z'),
    });
    await releaseQuota(reservation);

    expect(prisma.quotaUsage.updateMany).toHaveBeenCalledWith({
      where: {
        scope: 'CHAT',
        ownerId: 123n,
        chatId: -100n,
        kind: 'IMAGE',
        date: new Date('2026-07-28T00:00:00.000Z'),
        count: { gt: 0 },
      },
      data: { count: { decrement: 1 } },
    });
  });

  it('reports personal and group usage independently in a group', async () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    prisma.subscription.findMany
      .mockResolvedValueOnce([{ plan: 'WEEK', endsAt: now }])
      .mockResolvedValueOnce([
        { plan: 'WEEK', endsAt: now },
        { plan: 'MONTH', endsAt: now },
      ]);
    prisma.quotaUsage.findMany.mockResolvedValue([
      {
        scope: 'USER',
        ownerId: 123n,
        chatId: 0n,
        kind: 'PRIMARY_RESPONSE',
        count: 2,
      },
      {
        scope: 'CHAT',
        ownerId: 123n,
        chatId: -100n,
        kind: 'PRIMARY_RESPONSE',
        count: 3,
      },
    ]);

    const overview = await getQuotaOverview({
      userId: 123,
      chatId: -100,
      isGroup: true,
      now,
    });

    expect(overview.personal.PRIMARY_RESPONSE).toEqual({ limit: 30, used: 2 });
    expect(overview.chat?.PRIMARY_RESPONSE).toEqual({ limit: 8, used: 3 });
  });
});
