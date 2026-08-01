import { type Bot, webhookCallback } from 'grammy';
import type { BotContext } from './bot';
import { logger } from './logger';
import type {
  TransportConfig,
  WebhookTransportConfig,
} from './transport-config';

export interface BunWebhookRequest {
  headers: Headers;
  json: () => Promise<unknown>;
}

export type BunWebhookHandler = (
  request: BunWebhookRequest,
) => Promise<Response>;

export interface BotTransport {
  webhookPath?: string;
  webhookHandler?: BunWebhookHandler;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

function updateIdFromPayload(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object' || !('update_id' in payload)) {
    return undefined;
  }

  const updateId = (payload as { update_id?: unknown }).update_id;
  return typeof updateId === 'number' ? updateId : undefined;
}

function createWebhookHandler(
  bot: Bot<BotContext>,
  config: WebhookTransportConfig,
): BunWebhookHandler {
  const handleWebhook = webhookCallback(bot, 'bun', {
    secretToken: config.webhookSecret,
    timeoutMilliseconds: config.webhookTimeoutMs,
  });

  return async (request) => {
    const startedAt = Date.now();
    let payload: unknown;
    const response = await handleWebhook({
      headers: request.headers,
      json: async () => {
        payload = await request.json();
        return payload;
      },
    });

    logger.info(
      {
        event: 'transport.webhook_update_handled',
        updateId: updateIdFromPayload(payload),
        durationMs: Date.now() - startedAt,
        status: response.status,
      },
      'Webhook update handled',
    );
    return response;
  };
}

export function createBotTransport(
  bot: Bot<BotContext>,
  config: TransportConfig,
  onPollingError: (error: unknown) => void,
): BotTransport {
  if (config.mode === 'polling') {
    return {
      start: async () => {
        bot.start().catch(onPollingError);
        logger.info(
          { event: 'transport.started', mode: config.mode },
          'Bot transport started',
        );
      },
      stop: async () => {
        await bot.stop();
      },
    };
  }

  return {
    webhookPath: config.webhookPath,
    webhookHandler: createWebhookHandler(bot, config),
    start: async () => {
      await bot.api.setWebhook(config.webhookUrl, {
        drop_pending_updates: false,
        max_connections: 1,
        secret_token: config.webhookSecret,
      });
      logger.info(
        {
          event: 'transport.started',
          mode: config.mode,
          webhookConfigured: true,
        },
        'Bot transport started',
      );
    },
    stop: async () => {
      // Keep the webhook configured across graceful pod restarts.
    },
  };
}
