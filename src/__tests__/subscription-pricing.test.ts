import { describe, expect, it } from 'vitest';
import { getMoscowDay, planDetails } from '../shared/quota-service';
import { getDiscountedPrice } from '../shared/subscriptions';

describe('subscription pricing', () => {
  it('uses the weekly 50% promotion and rounds the week plan to 29 Stars', () => {
    const price = getDiscountedPrice({
      baseAmount: 49,
      paidPurchases: 0,
      now: new Date('2026-07-28T12:00:00+03:00'),
    });

    expect(price.amount).toBe(29);
    expect(price.actualDiscount).toBe(41);
  });

  it('uses a loyalty discount after the promotion ends and caps it at 30%', () => {
    const now = new Date('2026-08-10T12:00:00+03:00');

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
    expect(planDetails.WEEK.personal.PRIMARY_RESPONSE).toBe(30);
    expect(planDetails.YEAR.chat.VOICE).toBe(40);
  });
});
