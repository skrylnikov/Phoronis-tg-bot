import { prisma } from '../db';
import {
  PaymentOrderStatus,
  Prisma,
  type SubscriptionPlan,
} from '../generated/prisma/client';

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

export async function findActiveUserSubscriptions(userId: bigint, now: Date) {
  return prisma.subscription.findMany({
    where: {
      userId,
      startsAt: { lte: now },
      endsAt: { gt: now },
      revokedAt: null,
    },
    select: { id: true, plan: true, beneficiaryChatId: true, endsAt: true },
  });
}

export async function findActiveChatSubscriptions(chatId: bigint, now: Date) {
  return prisma.subscription.findMany({
    where: {
      beneficiaryChatId: chatId,
      startsAt: { lte: now },
      endsAt: { gt: now },
      revokedAt: null,
    },
    select: { id: true, plan: true, userId: true, endsAt: true },
  });
}

export async function createPurchaseSessionRepo(
  userId: bigint,
  beneficiaryChatId: bigint,
  expiresAt: Date,
) {
  const token = crypto.randomUUID().replaceAll('-', '');
  return prisma.purchaseSession.create({
    data: { token, userId, beneficiaryChatId, expiresAt },
  });
}

export async function findPurchaseSession(token: string) {
  return prisma.purchaseSession.findUnique({ where: { token } });
}

export async function updatePurchaseSessionTerms(
  token: string,
  termsAcceptedAt: Date,
  termsVersion: string,
) {
  return prisma.purchaseSession.update({
    where: { token },
    data: { termsAcceptedAt, termsVersion },
  });
}

export async function countPaidOrders(userId: bigint) {
  return prisma.paymentOrder.count({
    where: { userId, status: PaymentOrderStatus.PAID },
  });
}

export async function createPaymentOrderWithSession(input: {
  token: string;
  userId: bigint;
  beneficiaryChatId: bigint;
  plan: SubscriptionPlan;
  baseAmount: number;
  amount: number;
  discountPercent: number;
  termsAcceptedAt: Date;
  termsVersion: string;
  expiresAt: Date;
  now: Date;
  paymentTermsVersion: string;
}) {
  return prisma.$transaction(async (tx) => {
    const claimedSession = await tx.purchaseSession.deleteMany({
      where: {
        token: input.token,
        userId: input.userId,
        expiresAt: { gt: input.now },
        termsAcceptedAt: { not: null },
        termsVersion: input.paymentTermsVersion,
      },
    });
    if (claimedSession.count !== 1) {
      return null;
    }

    return tx.paymentOrder.create({
      data: {
        userId: input.userId,
        beneficiaryChatId: input.beneficiaryChatId,
        plan: input.plan,
        baseAmount: input.baseAmount,
        amount: input.amount,
        discountPercent: input.discountPercent,
        termsAcceptedAt: input.termsAcceptedAt,
        termsVersion: input.termsVersion,
        expiresAt: input.expiresAt,
      },
    });
  });
}

export async function findPaymentOrder(orderId: string) {
  return prisma.paymentOrder.findUnique({ where: { id: orderId } });
}

export async function expirePaymentOrder(orderId: string) {
  return prisma.paymentOrder.updateMany({
    where: { id: orderId, status: PaymentOrderStatus.PENDING },
    data: { status: PaymentOrderStatus.EXPIRED },
  });
}

export async function findPaymentOrderByChargeId(chargeId: string) {
  return prisma.paymentOrder.findUnique({
    where: { telegramPaymentChargeId: chargeId },
    include: { subscription: true },
  });
}

export async function findPendingPaymentOrder(
  orderId: string,
  userId: bigint,
  amount: number,
) {
  return prisma.paymentOrder.findFirst({
    where: {
      id: orderId,
      status: PaymentOrderStatus.PENDING,
      userId,
      amount,
    },
  });
}

export async function activatePaymentWithSubscription(input: {
  orderId: string;
  userId: bigint;
  beneficiaryChatId: bigint;
  plan: SubscriptionPlan;
  chargeId: string;
  startsAt: Date;
  durationDays: number;
  now: Date;
  amount: number;
}) {
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
        id: input.orderId,
        status: PaymentOrderStatus.PENDING,
        userId: input.userId,
        amount: input.amount,
      },
    });
    if (!pendingOrder) return null;

    const activeSubscriptions = await tx.subscription.findMany({
      where: {
        userId: input.userId,
        startsAt: { lte: input.now },
        revokedAt: null,
        endsAt: { gt: input.now },
      },
      select: { plan: true, endsAt: true },
    });

    const currentEndsAt = activeSubscriptions.reduce(
      (latest, subscription) =>
        subscription.endsAt > latest ? subscription.endsAt : latest,
      input.now,
    );

    const subscription = await tx.subscription.create({
      data: {
        userId: input.userId,
        beneficiaryChatId: input.beneficiaryChatId,
        plan: input.plan,
        startsAt: input.startsAt,
        endsAt: new Date(
          currentEndsAt.getTime() + input.durationDays * 24 * 60 * 60 * 1000,
        ),
      },
    });

    await tx.paymentOrder.update({
      where: { id: pendingOrder.id },
      data: {
        status: PaymentOrderStatus.PAID,
        paidAt: input.now,
        telegramPaymentChargeId: input.chargeId,
        subscriptionId: subscription.id,
      },
    });

    return { ...subscription, activatedNow: true };
  });
}

export async function refundPaymentWithSubscription(
  chargeId: string,
  now: Date,
  durationMs: number,
) {
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
