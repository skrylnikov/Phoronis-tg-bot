import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const mocks = vi.hoisted(() => ({
  activatePayment: vi.fn(),
  formatPaymentTerms: vi.fn(() => 'Условия'),
  getPlanTitle: vi.fn(() => '1 неделя'),
  sendPurchaseNotification: vi.fn(),
}));

vi.mock('../analytics', () => ({
  sendPurchaseNotification: mocks.sendPurchaseNotification,
}));
vi.mock('../config', () => ({ paymentSupportContact: '@support' }));
vi.mock('../domain', () => ({
  activatePayment: mocks.activatePayment,
  formatPaymentTerms: mocks.formatPaymentTerms,
  getPlanTitle: mocks.getPlanTitle,
  paymentTermsVersion: '2026-08-23',
  subscriptionPlans: ['WEEK'],
}));

import { successfulPaymentController } from '../controllers/subscription';

function createContext() {
  const reply = vi.fn().mockResolvedValue({});
  const sendMessage = vi.fn().mockResolvedValue({});
  return {
    context: {
      from: { id: 123, first_name: 'Покупатель' },
      msg: {
        successful_payment: {
          invoice_payload: 'order-payload',
          currency: 'XTR',
          total_amount: 99,
          telegram_payment_charge_id: 'charge-1',
        },
      },
      reply,
      api: { sendMessage },
    } as unknown as BotContext,
    reply,
    sendMessage,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendPurchaseNotification.mockResolvedValue(undefined);
});

describe('successful payment handling', () => {
  it('does not send Telegram confirmations for a duplicate charge', async () => {
    mocks.activatePayment.mockResolvedValue({
      activatedNow: false,
      plan: 'WEEK',
      endsAt: new Date('2026-08-08'),
      beneficiaryChatId: -100n,
    });
    const { context, reply, sendMessage } = createContext();

    await successfulPaymentController(context);

    expect(reply).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(mocks.sendPurchaseNotification).not.toHaveBeenCalled();
  });

  it('leaves confirmation delivery to durable background jobs', async () => {
    mocks.activatePayment.mockResolvedValue({
      activatedNow: true,
      plan: 'WEEK',
      endsAt: new Date('2026-08-08'),
      beneficiaryChatId: -100n,
    });
    const { context, reply, sendMessage } = createContext();

    await successfulPaymentController(context);

    expect(reply).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(mocks.sendPurchaseNotification).not.toHaveBeenCalled();
  });
});
