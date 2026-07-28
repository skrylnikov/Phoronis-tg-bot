import { prisma } from '../db';
import {
  PaymentOrderStatus,
  Prisma,
  SubscriptionPlan,
} from '../generated/prisma/client';
import {
  getMinimumPurchasablePlan,
  isPlanAtLeast,
  planDetails,
} from './quota-service';

const sessionLifetimeMs = 30 * 60 * 1000;
const orderLifetimeMs = 30 * 60 * 1000;
export const weeklyPromotionEndsAt = new Date('2026-08-02T21:00:00.000Z');
export const paymentTermsVersion = '2026-07-28';

export const subscriptionPlans = [
  SubscriptionPlan.WEEK,
  SubscriptionPlan.MONTH,
  SubscriptionPlan.QUARTER,
  SubscriptionPlan.YEAR,
] as const;

export interface PurchaseOption {
  plan: SubscriptionPlan;
  amount: number;
  actualDiscount: number;
  requestedDiscount: number;
  promotionEndsAt: Date;
}

export function getPlanTitle(plan: SubscriptionPlan): string {
  return {
    WEEK: '1 неделя',
    MONTH: '1 месяц',
    QUARTER: '3 месяца',
    YEAR: '1 год',
  }[plan];
}

export function getInvoicePayload(orderId: string): string {
  return `subscription:${orderId}`;
}

export function getOrderIdFromPayload(payload: string): string | null {
  const prefix = 'subscription:';
  return payload.startsWith(prefix) ? payload.slice(prefix.length) : null;
}

export class PurchaseValidationError extends Error {
  constructor(
    public readonly code:
      | 'SESSION_EXPIRED'
      | 'TERMS_NOT_ACCEPTED'
      | 'PLAN_DOWNGRADE',
  ) {
    super(code);
    this.name = 'PurchaseValidationError';
  }
}

async function runSerializableTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const canRetry =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034' &&
        attempt < maxAttempts;
      if (!canRetry) throw error;
    }
  }
  throw new Error('Serializable transaction retry limit reached');
}

function roundToNine(amount: number, baseAmount: number): number {
  const lower = Math.floor(amount / 10) * 10 - 1;
  const upper = lower + 10;
  const rounded = amount - lower <= upper - amount ? lower : upper;
  return Math.max(1, rounded >= baseAmount ? lower : rounded);
}

export function getDiscountedPrice(input: {
  baseAmount: number;
  paidPurchases: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const hasWeeklyPromotion = now < weeklyPromotionEndsAt;
  const loyaltyDiscount = Math.min(30, input.paidPurchases * 10);
  const requestedDiscount = hasWeeklyPromotion ? 50 : loyaltyDiscount;
  const amount = roundToNine(
    input.baseAmount * (1 - requestedDiscount / 100),
    input.baseAmount,
  );
  const actualDiscount = Math.round(
    ((input.baseAmount - amount) / input.baseAmount) * 100,
  );

  return {
    amount,
    actualDiscount,
    requestedDiscount,
    promotionEndsAt: weeklyPromotionEndsAt,
  };
}

export async function createPurchaseSession(input: {
  userId: number | bigint;
  beneficiaryChatId: number | bigint;
}) {
  const token = crypto.randomUUID().replaceAll('-', '');
  const now = new Date();
  return prisma.purchaseSession.create({
    data: {
      token,
      userId: BigInt(input.userId),
      beneficiaryChatId: BigInt(input.beneficiaryChatId),
      expiresAt: new Date(now.getTime() + sessionLifetimeMs),
    },
  });
}

export async function getPurchaseSession(
  token: string,
  userId: number | bigint,
  now = new Date(),
) {
  const session = await prisma.purchaseSession.findUnique({ where: { token } });
  if (
    !session ||
    session.userId !== BigInt(userId) ||
    session.expiresAt <= now
  ) {
    return null;
  }
  return session;
}

export async function acceptPurchaseTerms(
  token: string,
  userId: number | bigint,
) {
  const session = await getPurchaseSession(token, userId);
  if (!session) return null;
  return prisma.purchaseSession.update({
    where: { token: session.token },
    data: {
      termsAcceptedAt: new Date(),
      termsVersion: paymentTermsVersion,
    },
  });
}

export function hasAcceptedPaymentTerms(session: {
  termsAcceptedAt: Date | null;
  termsVersion: string | null;
}): boolean {
  return (
    session.termsAcceptedAt !== null &&
    session.termsVersion === paymentTermsVersion
  );
}

export async function getPurchaseOptions(
  userId: number | bigint,
  now = new Date(),
): Promise<PurchaseOption[]> {
  const [paidPurchases, minimumPlan] = await Promise.all([
    prisma.paymentOrder.count({
      where: { userId: BigInt(userId), status: PaymentOrderStatus.PAID },
    }),
    getMinimumPurchasablePlan(userId, now),
  ]);

  return subscriptionPlans
    .filter((plan) => !minimumPlan || isPlanAtLeast(plan, minimumPlan))
    .map((plan) => ({
      plan,
      ...getDiscountedPrice({
        baseAmount: planDetails[plan].amount,
        paidPurchases,
        now,
      }),
    }));
}

export async function createPaymentOrder(input: {
  userId: number | bigint;
  plan: SubscriptionPlan;
  purchaseToken: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const session = await getPurchaseSession(
    input.purchaseToken,
    input.userId,
    now,
  );
  if (!session) throw new PurchaseValidationError('SESSION_EXPIRED');
  if (!hasAcceptedPaymentTerms(session)) {
    throw new PurchaseValidationError('TERMS_NOT_ACCEPTED');
  }
  const minimumPlan = await getMinimumPurchasablePlan(input.userId, now);
  if (minimumPlan && !isPlanAtLeast(input.plan, minimumPlan)) {
    throw new PurchaseValidationError('PLAN_DOWNGRADE');
  }

  const details = planDetails[input.plan];
  const paidPurchases = await prisma.paymentOrder.count({
    where: { userId: BigInt(input.userId), status: PaymentOrderStatus.PAID },
  });
  const price = getDiscountedPrice({
    baseAmount: details.amount,
    paidPurchases,
    now,
  });
  const regularExpiry = new Date(now.getTime() + orderLifetimeMs);
  const expiresAt =
    price.requestedDiscount === 50 && weeklyPromotionEndsAt < regularExpiry
      ? weeklyPromotionEndsAt
      : regularExpiry;
  return prisma.$transaction(async (tx) => {
    const claimedSession = await tx.purchaseSession.deleteMany({
      where: {
        token: input.purchaseToken,
        userId: BigInt(input.userId),
        expiresAt: { gt: now },
        termsAcceptedAt: { not: null },
        termsVersion: paymentTermsVersion,
      },
    });
    if (claimedSession.count !== 1) {
      throw new PurchaseValidationError('SESSION_EXPIRED');
    }

    return tx.paymentOrder.create({
      data: {
        userId: BigInt(input.userId),
        beneficiaryChatId: session.beneficiaryChatId,
        plan: input.plan,
        baseAmount: details.amount,
        amount: price.amount,
        discountPercent: price.actualDiscount,
        termsAcceptedAt: session.termsAcceptedAt as Date,
        termsVersion: session.termsVersion as string,
        expiresAt,
      },
    });
  });
}

export async function validatePaymentOrder(input: {
  invoicePayload: string;
  userId: number | bigint;
  currency: string;
  amount: number;
  now?: Date;
}) {
  const orderId = getOrderIdFromPayload(input.invoicePayload);
  if (!orderId || input.currency !== 'XTR') return null;

  const order = await prisma.paymentOrder.findUnique({
    where: { id: orderId },
  });
  const now = input.now ?? new Date();
  if (
    !order ||
    order.status !== PaymentOrderStatus.PENDING ||
    order.userId !== BigInt(input.userId) ||
    order.amount !== input.amount ||
    order.expiresAt <= now
  ) {
    if (
      order?.status === PaymentOrderStatus.PENDING &&
      order.expiresAt <= now
    ) {
      await prisma.paymentOrder.updateMany({
        where: { id: order.id, status: PaymentOrderStatus.PENDING },
        data: { status: PaymentOrderStatus.EXPIRED },
      });
    }
    return null;
  }
  const minimumPlan = await getMinimumPurchasablePlan(input.userId, now);
  if (minimumPlan && !isPlanAtLeast(order.plan, minimumPlan)) return null;
  return order;
}

export async function activatePayment(input: {
  invoicePayload: string;
  userId: number | bigint;
  currency: string;
  amount: number;
  chargeId: string;
  now?: Date;
}) {
  const orderId = getOrderIdFromPayload(input.invoicePayload);
  if (!orderId || input.currency !== 'XTR') return null;
  const now = input.now ?? new Date();

  return runSerializableTransaction(async (tx) => {
    const existingCharge = await tx.paymentOrder.findUnique({
      where: { telegramPaymentChargeId: input.chargeId },
      include: { subscription: true },
    });
    if (existingCharge) {
      return existingCharge.subscription
        ? { ...existingCharge.subscription, activatedNow: false }
        : null;
    }

    const pendingOrder = await tx.paymentOrder.findFirst({
      where: {
        id: orderId,
        status: PaymentOrderStatus.PENDING,
        userId: BigInt(input.userId),
        amount: input.amount,
      },
    });
    if (!pendingOrder) return null;
    const details = planDetails[pendingOrder.plan];
    const activeSubscriptions = await tx.subscription.findMany({
      where: {
        userId: pendingOrder.userId,
        startsAt: { lte: now },
        revokedAt: null,
        endsAt: { gt: now },
      },
      select: { plan: true, endsAt: true },
    });
    const currentEndsAt = activeSubscriptions.reduce(
      (latest, subscription) =>
        subscription.endsAt > latest ? subscription.endsAt : latest,
      now,
    );

    const subscription = await tx.subscription.create({
      data: {
        userId: pendingOrder.userId,
        beneficiaryChatId: pendingOrder.beneficiaryChatId,
        plan: pendingOrder.plan,
        startsAt: now,
        endsAt: new Date(
          currentEndsAt.getTime() + details.durationDays * 24 * 60 * 60 * 1000,
        ),
      },
    });

    await tx.paymentOrder.update({
      where: { id: pendingOrder.id },
      data: {
        status: PaymentOrderStatus.PAID,
        paidAt: now,
        telegramPaymentChargeId: input.chargeId,
        subscriptionId: subscription.id,
      },
    });

    return { ...subscription, activatedNow: true };
  });
}

export async function refundPayment(chargeId: string, now = new Date()) {
  return runSerializableTransaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({
      where: { telegramPaymentChargeId: chargeId },
    });
    if (!order || order.status !== PaymentOrderStatus.PAID) return null;
    const refundedSubscription = order.subscriptionId
      ? await tx.subscription.findUnique({
          where: { id: order.subscriptionId },
        })
      : null;
    await tx.paymentOrder.update({
      where: { id: order.id },
      data: { status: PaymentOrderStatus.REFUNDED, refundedAt: now },
    });
    if (order.subscriptionId) {
      await tx.subscription.updateMany({
        where: { id: order.subscriptionId, revokedAt: null },
        data: { revokedAt: now },
      });
    }
    if (refundedSubscription) {
      const durationMs =
        planDetails[order.plan].durationDays * 24 * 60 * 60 * 1000;
      const laterSubscriptions = await tx.subscription.findMany({
        where: {
          userId: order.userId,
          endsAt: { gt: refundedSubscription.endsAt },
          revokedAt: null,
        },
        select: { id: true, endsAt: true },
      });
      await Promise.all(
        laterSubscriptions.map((subscription) =>
          tx.subscription.update({
            where: { id: subscription.id },
            data: {
              endsAt: new Date(subscription.endsAt.getTime() - durationMs),
            },
          }),
        ),
      );
    }
    return order;
  });
}
