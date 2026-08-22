import { describe, expect, it } from 'vitest';
import { getMoscowDay, planDetails } from '../shared/quota-service';
import { getDiscountedPrice } from '../shared/subscriptions';

describe('subscription pricing', () => {
  it('applies 20% August promotion discount on all plans while active', () => {
    const now = new Date('2026-08-23T12:00:00+03:00');

    expect(
      getDiscountedPrice({ baseAmount: 49, paidPurchases: 0, now }),
    ).toMatchObject({
      amount: 39,
      actualDiscount: 20,
      requestedDiscount: 20,
    });
    expect(
      getDiscountedPrice({ baseAmount: 99, paidPurchases: 0, now }),
    ).toMatchObject({
      amount: 79,
      actualDiscount: 20,
      requestedDiscount: 20,
    });
    expect(
      getDiscountedPrice({ baseAmount: 199, paidPurchases: 0, now }),
    ).toMatchObject({
      amount: 159,
      actualDiscount: 20,
      requestedDiscount: 20,
    });
    expect(
      getDiscountedPrice({ baseAmount: 599, paidPurchases: 0, now }),
    ).toMatchObject({
      amount: 479,
      actualDiscount: 20,
      requestedDiscount: 20,
    });
  });

  it('ends August promotion after 2026-08-31 23:59:59 Europe/Moscow', () => {
    const afterPromotionUTC = new Date('2026-08-31T21:00:00.000Z');
    const price = getDiscountedPrice({
      baseAmount: 49,
      paidPurchases: 1,
      now: afterPromotionUTC,
    });

    expect(price.requestedDiscount).toBe(10);
    expect(price.amount).toBe(39);
  });

  it('uses a loyalty discount after the August promotion ends and caps it at 30%', () => {
    const now = new Date('2026-09-01T12:00:00+03:00');

    expect(
      getDiscountedPrice({ baseAmount: 49, paidPurchases: 1, now }),
    ).toMatchObject({
      amount: 39,
      actualDiscount: 20,
    });
    expect(
      getDiscountedPrice({ baseAmount: 99, paidPurchases: 2, now }),
    ).toMatchObject({
      amount: 79,
      actualDiscount: 20,
    });
    expect(
      getDiscountedPrice({ baseAmount: 99, paidPurchases: 9, now }),
    ).toMatchObject({
      amount: 69,
      actualDiscount: 30,
    });
  });

  it('uses Moscow calendar days and keeps the approved tariff limits', () => {
    expect(getMoscowDay(new Date('2026-07-28T23:30:00Z'))).toEqual(
      new Date('2026-07-29T00:00:00.000Z'),
    );
    expect(planDetails.WEEK.personal.PRIMARY_RESPONSE).toBe(10);
    expect(planDetails.YEAR.chat.VOICE).toBe(10);
  });
});
