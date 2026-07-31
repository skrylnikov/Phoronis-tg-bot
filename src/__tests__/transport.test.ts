import type { Bot } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';
import { createBotTransport } from '../transport';
import type { TransportConfig } from '../transport-config';

function createBot() {
  return {
    api: {
      setWebhook: vi.fn(async () => true),
    },
    handleUpdate: vi.fn(async () => undefined),
    init: vi.fn(async () => undefined),
    isRunning: vi.fn(() => false),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as Bot<BotContext>;
}

describe('bot transport', () => {
  it('starts polling without configuring a webhook', async () => {
    const bot = createBot();
    const transport = createBotTransport(bot, { mode: 'polling' }, vi.fn());

    await transport.start();

    expect(bot.start).toHaveBeenCalledOnce();
    expect(bot.api.setWebhook).not.toHaveBeenCalled();
  });

  it('configures webhook without starting polling', async () => {
    const bot = createBot();
    const pollingStart = bot.start;
    const config: TransportConfig = {
      mode: 'webhook',
      webhookUrl: 'https://phoronis.example.test/telegram/webhook',
      webhookPath: '/telegram/webhook',
      webhookSecret: 'secret_123',
      webhookTimeoutMs: 50_000,
    };
    const transport = createBotTransport(bot, config, vi.fn());

    await transport.start();

    expect(bot.api.setWebhook).toHaveBeenCalledWith(config.webhookUrl, {
      drop_pending_updates: false,
      max_connections: 1,
      secret_token: config.webhookSecret,
    });
    expect(pollingStart).not.toHaveBeenCalled();
  });

  it('rejects a webhook request with the wrong secret', async () => {
    const bot = createBot();
    const transport = createBotTransport(
      bot,
      {
        mode: 'webhook',
        webhookUrl: 'https://phoronis.example.test/telegram/webhook',
        webhookPath: '/telegram/webhook',
        webhookSecret: 'secret_123',
        webhookTimeoutMs: 50_000,
      },
      vi.fn(),
    );
    const json = vi.fn(async () => ({ update_id: 1 }));

    const response = await transport.webhookHandler?.({
      headers: new Headers({
        'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret',
      }),
      json,
    });

    expect(response?.status).toBe(401);
    expect(json).not.toHaveBeenCalled();
  });

  it('handles a valid webhook update', async () => {
    const bot = createBot();
    const transport = createBotTransport(
      bot,
      {
        mode: 'webhook',
        webhookUrl: 'https://phoronis.example.test/telegram/webhook',
        webhookPath: '/telegram/webhook',
        webhookSecret: 'secret_123',
        webhookTimeoutMs: 50_000,
      },
      vi.fn(),
    );
    const update = { update_id: 42 };

    const response = await transport.webhookHandler?.({
      headers: new Headers({
        'X-Telegram-Bot-Api-Secret-Token': 'secret_123',
      }),
      json: async () => update,
    });

    expect(response?.status).toBe(200);
    expect(bot.handleUpdate).toHaveBeenCalledWith(update, expect.anything());
  });
});
