import { describe, expect, it } from 'vitest';
import { planDetails } from '../domain/quota-service';
import {
  formatInvoiceDescription,
  formatPaymentTerms,
  formatSubscriptionCatalog,
} from '../domain/subscription-presentation';
import {
  getPlanTitle,
  paymentTermsVersion,
  subscriptionPlans,
} from '../domain/subscription-rules';

describe('subscription presentation', () => {
  it('states the current personal and group quota contract', () => {
    const text = formatPaymentTerms();

    expect(text).toContain(
      'Личные лимиты выбранного тарифа являются итоговыми и заменяют бесплатные дневные лимиты.',
    );
    expect(text).toContain(
      'Активные подписки, оформленные для одной группы, суммируются.',
    );
    expect(text).toContain(
      'Каждый участник получает независимую групповую квоту',
    );
    expect(text).toContain(
      'сначала расходуется групповая квота, затем личная.',
    );
    expect(text).not.toContain(
      'Подписка прибавляет лимиты к вашим бесплатным дневным лимитам',
    );
    expect(text).toContain(`Версия: ${paymentTermsVersion}.`);
  });

  it('uses the domain catalog for every tariff in the catalog and invoice', () => {
    const options = subscriptionPlans.map((plan) => ({
      plan,
      amount: planDetails[plan].amount,
      actualDiscount: 0,
      requestedDiscount: 0,
      promotionEndsAt: new Date('2026-08-31T20:59:59.999Z'),
    }));
    const catalog = formatSubscriptionCatalog(options);

    for (const plan of subscriptionPlans) {
      const details = planDetails[plan];
      expect(catalog).toContain(
        `«${getPlanTitle(plan)}»\nОбычная цена: ${details.amount} ⭐`,
      );

      const invoice = formatInvoiceDescription({
        plan,
        amount: details.amount,
        discountPercent: 0,
        expiresAt: new Date('2026-08-10T09:30:00.000Z'),
      });
      expect(invoice).toContain(`Обычная цена: ${details.amount} ⭐`);
    }
  });

  it('shows the promotional price and every daily quota in the catalog', () => {
    const text = formatSubscriptionCatalog([
      {
        plan: 'WEEK',
        amount: 39,
        actualDiscount: 20,
        requestedDiscount: 20,
        promotionEndsAt: new Date('2026-08-31T20:59:59.999Z'),
      },
    ]);

    expect(text).toContain('Обычная цена: 49 ⭐');
    expect(text).toContain('Цена со скидкой 20%: 39 ⭐');
    expect(text).toContain(
      'Личные лимиты в день:\n• Основные ответы: 30\n• Изображения: 15\n• Голосовые: 30\n• Анализ контекста: безлимит',
    );
    expect(text).toContain(
      'Групповые лимиты для каждого участника в день:\n• Основные ответы: 3\n• Изображения: 3\n• Голосовые: 6\n• Анализ контекста: 1',
    );
    expect(text).toContain('Все лимиты обновляются ежедневно в 00:00 МСК.');
  });

  it('uses the same loyalty-discounted price in the invoice summary', () => {
    const text = formatInvoiceDescription({
      plan: 'MONTH',
      amount: 79,
      discountPercent: 20,
      expiresAt: new Date('2026-08-10T09:30:00.000Z'),
    });

    expect(text).toContain('Обычная цена: 99 ⭐');
    expect(text).toContain('Цена со скидкой 20%: 79 ⭐');
    expect(text).toContain('Счёт действителен до 12:30 МСК.');
  });

  it('does not show a discount for a regular-price invoice', () => {
    const text = formatInvoiceDescription({
      plan: 'YEAR',
      amount: 599,
      discountPercent: 0,
      expiresAt: new Date('2026-08-10T09:30:00.000Z'),
    });

    expect(text).toContain('Обычная цена: 599 ⭐');
    expect(text).toContain('Цена: 599 ⭐');
    expect(text).not.toContain('скидк');
  });
});
