import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimedBackgroundJob } from '../repositories/background-job-repository';

const mocks = vi.hoisted(() => ({
  sendPurchaseNotification: vi.fn(),
}));

vi.mock('../analytics', () => ({
  sendPurchaseNotification: mocks.sendPurchaseNotification,
}));
vi.mock('../domain/subscriptions', () => ({
  getPlanTitle: vi.fn(() => '1 месяц'),
}));
vi.mock('../application/user-message-analysis', () => ({
  analyzeUserMessagesForUser: vi.fn(),
}));

import { createPaymentBackgroundJobHandlers } from '../payment-background-jobs';

function paymentJob(
  type: ClaimedBackgroundJob['type'],
  externalDeliveryId: string | null = null,
): ClaimedBackgroundJob {
  return {
    id: 'job-1',
    type,
    dedupeKey: 'payment-order:order-1:buyer',
    payload: {
      orderId: 'order-1',
      userId: '100',
      beneficiaryChatId: '-200',
      plan: 'MONTH',
      amount: 99,
      buyer: { firstName: 'Иван' },
    },
    attempts: 1,
    externalDeliveryId,
  };
}

describe('payment background jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendPurchaseNotification.mockResolvedValue(303);
  });

  it('returns the Telegram message id for a buyer notification', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 101 });
    const handlers = createPaymentBackgroundJobHandlers({
      sendMessage,
    } as never);

    await expect(
      handlers.PAYMENT_BUYER_NOTIFICATION(
        paymentJob('PAYMENT_BUYER_NOTIFICATION'),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ externalDeliveryId: '101' });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('does not send a notification after its delivery id is persisted', async () => {
    const sendMessage = vi.fn();
    const handlers = createPaymentBackgroundJobHandlers({
      sendMessage,
    } as never);

    await expect(
      handlers.PAYMENT_BENEFICIARY_NOTIFICATION(
        paymentJob('PAYMENT_BENEFICIARY_NOTIFICATION', '202'),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('returns the delivery id for the analytics notification', async () => {
    const handlers = createPaymentBackgroundJobHandlers({} as never);

    await expect(
      handlers.PAYMENT_ANALYTICS_NOTIFICATION(
        paymentJob('PAYMENT_ANALYTICS_NOTIFICATION'),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ externalDeliveryId: '303' });
  });
});
