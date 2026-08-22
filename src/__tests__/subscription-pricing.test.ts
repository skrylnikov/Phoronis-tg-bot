import { describe, expect, it } from 'vitest';
import {
  freeLimits,
  getMoscowDay,
  getPersonalDailyLimits,
  planDetails,
} from '../shared/quota-service';
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

  it('returns correct personal and chat limits for all plans', () => {
    const testCases = [
      {
        plan: 'FREE',
        personal: { PRIMARY_RESPONSE: 10, IMAGE: 5, VOICE: 10, ANALYSIS: 1 },
        chat: null,
      },
      {
        plan: 'WEEK',
        personal: {
          PRIMARY_RESPONSE: 30,
          IMAGE: 15,
          VOICE: 30,
          ANALYSIS: Number.POSITIVE_INFINITY,
        },
        chat: { PRIMARY_RESPONSE: 3, IMAGE: 3, VOICE: 6, ANALYSIS: 1 },
      },
      {
        plan: 'MONTH',
        personal: {
          PRIMARY_RESPONSE: 50,
          IMAGE: 30,
          VOICE: 60,
          ANALYSIS: Number.POSITIVE_INFINITY,
        },
        chat: { PRIMARY_RESPONSE: 5, IMAGE: 5, VOICE: 10, ANALYSIS: 3 },
      },
      {
        plan: 'QUARTER',
        personal: {
          PRIMARY_RESPONSE: 100,
          IMAGE: 50,
          VOICE: 100,
          ANALYSIS: Number.POSITIVE_INFINITY,
        },
        chat: { PRIMARY_RESPONSE: 10, IMAGE: 10, VOICE: 20, ANALYSIS: 5 },
      },
      {
        plan: 'YEAR',
        personal: {
          PRIMARY_RESPONSE: 500,
          IMAGE: 200,
          VOICE: 400,
          ANALYSIS: Number.POSITIVE_INFINITY,
        },
        chat: { PRIMARY_RESPONSE: 20, IMAGE: 20, VOICE: 40, ANALYSIS: 10 },
      },
    ] as const;

    for (const { plan, personal, chat } of testCases) {
      if (plan === 'FREE') {
        const limits = getPersonalDailyLimits([]);
        expect(limits).toEqual(freeLimits);
        expect(limits.PRIMARY_RESPONSE).toBe(personal.PRIMARY_RESPONSE);
        expect(limits.IMAGE).toBe(personal.IMAGE);
        expect(limits.VOICE).toBe(personal.VOICE);
        expect(limits.ANALYSIS).toBe(personal.ANALYSIS);
      } else {
        const details = planDetails[plan];
        expect(details.personal.PRIMARY_RESPONSE).toBe(
          personal.PRIMARY_RESPONSE,
        );
        expect(details.personal.IMAGE).toBe(personal.IMAGE);
        expect(details.personal.VOICE).toBe(personal.VOICE);
        expect(details.personal.ANALYSIS).toBe(personal.ANALYSIS);

        if (chat) {
          expect(details.chat.PRIMARY_RESPONSE).toBe(chat.PRIMARY_RESPONSE);
          expect(details.chat.IMAGE).toBe(chat.IMAGE);
          expect(details.chat.VOICE).toBe(chat.VOICE);
          expect(details.chat.ANALYSIS).toBe(chat.ANALYSIS);
        }

        const personalLimits = getPersonalDailyLimits([{ plan }]);
        expect(personalLimits.PRIMARY_RESPONSE).toBe(personal.PRIMARY_RESPONSE);
        expect(personalLimits.IMAGE).toBe(personal.IMAGE);
        expect(personalLimits.VOICE).toBe(personal.VOICE);
        expect(personalLimits.ANALYSIS).toBe(personal.ANALYSIS);
      }
    }
  });
});
