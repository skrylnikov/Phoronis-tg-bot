import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const {
  acceptPurchaseTerms,
  formatPaymentTerms,
  formatSubscriptionCatalog,
  getMinimumPurchasablePlan,
  getPlanTitle,
  getPurchaseOptions,
} = vi.hoisted(() => ({
  acceptPurchaseTerms: vi.fn(),
  formatPaymentTerms: vi.fn(() => 'Условия'),
  formatSubscriptionCatalog: vi.fn(() => 'Тарифы'),
  getMinimumPurchasablePlan: vi.fn(),
  getPlanTitle: vi.fn(() => '1 неделя'),
  getPurchaseOptions: vi.fn(),
}));

vi.mock('../config', () => ({ paymentSupportContact: '@support' }));
vi.mock('../analytics', () => ({ sendPurchaseNotification: vi.fn() }));
vi.mock('../domain', () => ({
  acceptPurchaseTerms,
  formatPaymentTerms,
  formatSubscriptionCatalog,
  getMinimumPurchasablePlan,
  getPlanTitle,
  getPurchaseOptions,
  paymentTermsVersion: '2026-08-23',
  subscriptionPlans: ['WEEK'],
}));

import { subscriptionCallbackController } from '../controllers/subscription';

function createContext() {
  const answerCallbackQuery = vi.fn().mockResolvedValue(true);
  const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);
  const editMessageText = vi.fn().mockResolvedValue(true);
  const reply = vi.fn().mockResolvedValue({ message_id: 2 });

  return {
    answerCallbackQuery,
    context: {
      callbackQuery: { data: 'subscription:accept:purchasetoken' },
      chatId: 123,
      from: { id: 123 },
      answerCallbackQuery,
      editMessageReplyMarkup,
      editMessageText,
      reply,
    } as unknown as BotContext,
    editMessageReplyMarkup,
    editMessageText,
    reply,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  acceptPurchaseTerms.mockResolvedValue({ token: 'purchasetoken' });
  getMinimumPurchasablePlan.mockResolvedValue(null);
  getPurchaseOptions.mockResolvedValue([
    { plan: 'WEEK', amount: 49, actualDiscount: 0 },
  ]);
});

describe('subscription terms acceptance', () => {
  it('marks the terms message as accepted and removes its button', async () => {
    const { context, editMessageReplyMarkup, editMessageText, reply } =
      createContext();

    await subscriptionCallbackController(context);

    expect(editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('✅ Условия приняты'),
    );
    expect(editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(editMessageText.mock.invocationCallOrder[0]).toBeLessThan(
      reply.mock.invocationCallOrder[0],
    );
    expect(reply).toHaveBeenCalledWith(
      'Тарифы\n\nВыберите тариф. Личные и групповые лимиты начнут действовать сразу после оплаты.',
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([
              {
                callback_data: 'subscription:WEEK:purchasetoken',
                text: '1 неделя — 49 ⭐',
              },
            ]),
          ]),
        }),
      }),
    );
  });

  it('leaves the terms message unchanged when the purchase link has expired', async () => {
    acceptPurchaseTerms.mockResolvedValue(null);
    const {
      context,
      answerCallbackQuery,
      editMessageReplyMarkup,
      editMessageText,
    } = createContext();

    await subscriptionCallbackController(context);

    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Ссылка устарела',
    });
    expect(editMessageText).not.toHaveBeenCalled();
    expect(editMessageReplyMarkup).not.toHaveBeenCalled();
  });
});
