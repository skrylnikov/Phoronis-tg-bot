import {
  getMinimumPurchasablePlan,
  isPlanAtLeast,
  planDetails,
} from '../domain/quota-service';
import {
  augustPromotionEndsAt,
  getDiscountedPrice,
  getOrderIdFromPayload,
  hasAcceptedPaymentTerms,
  type PurchaseOption,
  PurchaseValidationError,
  paymentTermsVersion,
  subscriptionPlans,
} from '../domain/subscription-rules';
import {
  PaymentOrderStatus,
  type SubscriptionPlan,
} from '../generated/prisma/client';
import {
  activatePaymentWithSubscription,
  countPaidOrders,
  createPaymentOrderWithSession,
  createPurchaseSessionRepo,
  ensurePaymentNotificationJobsRepo,
  expirePaymentOrder,
  findPaymentOrder,
  findPaymentOrderByChargeId,
  findPendingPaymentOrder,
  findPurchaseSession,
  refundPaymentWithSubscription,
  updatePurchaseSessionTerms,
} from '../repositories';

const sessionLifetimeMs = 30 * 60 * 1000;
const orderLifetimeMs = 30 * 60 * 1000;

export async function createPurchaseSession(input: {
  userId: number | bigint;
  beneficiaryChatId: number | bigint;
}) {
  const now = new Date();
  return createPurchaseSessionRepo(
    BigInt(input.userId),
    BigInt(input.beneficiaryChatId),
    new Date(now.getTime() + sessionLifetimeMs),
  );
}

export async function getPurchaseSession(
  token: string,
  userId: number | bigint,
  now = new Date(),
) {
  const session = await findPurchaseSession(token);
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
  return updatePurchaseSessionTerms(
    session.token,
    new Date(),
    paymentTermsVersion,
  );
}

export async function getPurchaseOptions(
  userId: number | bigint,
  now = new Date(),
): Promise<PurchaseOption[]> {
  const [paidPurchases, minimumPlan] = await Promise.all([
    countPaidOrders(BigInt(userId)),
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
  const paidPurchases = await countPaidOrders(BigInt(input.userId));
  const price = getDiscountedPrice({
    baseAmount: details.amount,
    paidPurchases,
    now,
  });
  const regularExpiry = new Date(now.getTime() + orderLifetimeMs);
  const expiresAt =
    price.requestedDiscount === 20 && augustPromotionEndsAt < regularExpiry
      ? augustPromotionEndsAt
      : regularExpiry;
  const order = await createPaymentOrderWithSession({
    token: input.purchaseToken,
    userId: BigInt(input.userId),
    beneficiaryChatId: session.beneficiaryChatId,
    plan: input.plan,
    baseAmount: details.amount,
    amount: price.amount,
    discountPercent: price.actualDiscount,
    termsAcceptedAt: session.termsAcceptedAt as Date,
    termsVersion: session.termsVersion as string,
    expiresAt,
    now,
    paymentTermsVersion,
  });
  if (!order) throw new PurchaseValidationError('SESSION_EXPIRED');
  return order;
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

  const order = await findPaymentOrder(orderId);
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
      await expirePaymentOrder(order.id);
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
  buyer?: {
    firstName: string;
    lastName?: string;
    username?: string;
  };
  now?: Date;
}) {
  const orderId = getOrderIdFromPayload(input.invoicePayload);
  if (!orderId || input.currency !== 'XTR') return null;
  const now = input.now ?? new Date();

  const existingOrder = await findPaymentOrderByChargeId(input.chargeId);
  if (existingOrder?.subscription) {
    await ensurePaymentNotificationJobsRepo({
      order: existingOrder,
      buyer: input.buyer ?? { firstName: 'Пользователь' },
    });
    return { ...existingOrder.subscription, activatedNow: false };
  }

  const pendingOrder = await findPendingPaymentOrder(
    orderId,
    BigInt(input.userId),
    input.amount,
  );
  if (!pendingOrder) return null;

  const details = planDetails[pendingOrder.plan];
  if (!details) return null;

  return activatePaymentWithSubscription({
    orderId: pendingOrder.id,
    userId: pendingOrder.userId,
    beneficiaryChatId: pendingOrder.beneficiaryChatId,
    plan: pendingOrder.plan,
    chargeId: input.chargeId,
    startsAt: now,
    durationDays: details.durationDays,
    now,
    amount: input.amount,
    buyer: input.buyer ?? { firstName: 'Пользователь' },
  });
}

export async function refundPayment(chargeId: string, now = new Date()) {
  const order = await findPaymentOrderByChargeId(chargeId);
  if (!order?.plan) return null;

  const durationMs = planDetails[order.plan].durationDays * 24 * 60 * 60 * 1000;
  return refundPaymentWithSubscription(chargeId, now, durationMs);
}
