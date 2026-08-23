export const augustPromotionEndsAt = new Date('2026-08-31T20:59:59.999Z');
export const paymentTermsVersion = '2026-07-28';

export type SubscriptionPlan = 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';

export const subscriptionPlans = ['WEEK', 'MONTH', 'QUARTER', 'YEAR'] as const;

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
  const hasAugustPromotion = now < augustPromotionEndsAt;
  const loyaltyDiscount = Math.min(30, input.paidPurchases * 10);
  const requestedDiscount = hasAugustPromotion ? 20 : loyaltyDiscount;
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
    promotionEndsAt: augustPromotionEndsAt,
  };
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
