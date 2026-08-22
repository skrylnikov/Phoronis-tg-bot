import { describe, expect, it } from 'vitest';
import {
  formatInvoiceDescription,
  formatSubscriptionCatalog,
} from '../shared/subscription-presentation';

describe('subscription presentation', () => {
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
      baseAmount: 99,
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
      baseAmount: 599,
      amount: 599,
      discountPercent: 0,
      expiresAt: new Date('2026-08-10T09:30:00.000Z'),
    });

    expect(text).toContain('Обычная цена: 599 ⭐');
    expect(text).toContain('Цена: 599 ⭐');
    expect(text).not.toContain('скидк');
  });
});
