import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const { createPurchaseSession, shouldSendLimitNotice } = vi.hoisted(() => ({
  createPurchaseSession: vi.fn().mockResolvedValue({ token: 'purchase-token' }),
  shouldSendLimitNotice: vi.fn().mockResolvedValue(true),
}));

vi.mock('../shared', () => ({
  createPurchaseSession,
  shouldSendLimitNotice,
}));

import { sendMediaLimitNotice } from '../controllers/limit-notice';

function createContext(ephemeralMessageId?: number) {
  const reply = vi.fn().mockResolvedValue({ message_id: 1 });
  return {
    context: {
      chat: { id: -100, type: 'supergroup' },
      chatId: -100,
      from: { id: 123 },
      me: { username: 'phoronis_bot' },
      msg: {
        message_id: ephemeralMessageId ? 0 : 10,
        ephemeral_message_id: ephemeralMessageId,
      },
      reply,
    } as unknown as BotContext,
    reply,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('media limit notice', () => {
  it('sends an ordinary message for an ordinary group update', async () => {
    const { context, reply } = createContext();

    await sendMediaLimitNotice(context, 'IMAGE_LIMIT');

    expect(reply).toHaveBeenCalledWith(expect.any(String), {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Подписка',
              url: 'https://t.me/phoronis_bot?start=buy_purchase-token',
            },
          ],
        ],
      },
    });
  });

  it('links a notice to an incoming ephemeral /ask update', async () => {
    const { context, reply } = createContext(321);

    await sendMediaLimitNotice(context, 'IMAGE_LIMIT');

    expect(reply).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        receiver_user_id: 123,
        reply_parameters: { ephemeral_message_id: 321 },
      }),
    );
  });
});
