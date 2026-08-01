import type { Update } from '@grammyjs/types';
import type { Bot } from 'grammy';
import type { BotContext } from './bot';
import { logger } from './logger';
import {
  createTelegramUpdateQueue,
  isTelegramUpdate,
  type TelegramUpdateQueue,
} from './telegram-update-queue';
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
  return isTelegramUpdate(payload) ? payload.update_id : undefined;
}

function hasValidSecret(headers: Headers, expected: string): boolean {
  const actual = headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!actual || actual.length !== expected.length) return false;

  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function createWebhookHandler(
  queue: TelegramUpdateQueue,
  config: WebhookTransportConfig,
): BunWebhookHandler {
  return async (request) => {
    const startedAt = Date.now();
    if (!hasValidSecret(request.headers, config.webhookSecret)) {
      logger.warn(
        { event: 'transport.webhook_unauthorized' },
        'Rejected webhook request with an invalid secret',
      );
      return new Response('Unauthorized', { status: 401 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch (error) {
      logger.warn(
        { event: 'transport.webhook_invalid_payload', err: error },
        'Rejected webhook request with invalid JSON',
      );
      return new Response('Bad Request', { status: 400 });
    }

    if (!isTelegramUpdate(payload)) {
      logger.warn(
        { event: 'transport.webhook_invalid_payload' },
        'Rejected webhook request without a valid update_id',
      );
      return new Response('Bad Request', { status: 400 });
    }

    try {
      const result = await queue.enqueue(payload as Update);
      logger.info(
        {
          event: 'transport.webhook_update_enqueued',
          updateId: updateIdFromPayload(payload),
          duplicate: result.duplicate,
          lane: result.lane,
          partitionKey: result.partitionKey,
          durationMs: Date.now() - startedAt,
          status: 200,
        },
        'Webhook update accepted',
      );
      return Response.json({ ok: true });
    } catch (error) {
      logger.error(
        {
          event: 'transport.webhook_failed',
          updateId: updateIdFromPayload(payload),
          durationMs: Date.now() - startedAt,
          err: error,
        },
        'Failed to enqueue webhook update',
      );
      return new Response('Internal Server Error', { status: 500 });
    }
  };
}

export function createBotTransport(
  bot: Bot<BotContext>,
  config: TransportConfig,
  onPollingError: (error: unknown) => void,
  providedQueue?: TelegramUpdateQueue,
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

  const queue = providedQueue ?? createTelegramUpdateQueue(bot);

  return {
    webhookPath: config.webhookPath,
    webhookHandler: createWebhookHandler(queue, config),
    start: async () => {
      await queue.start();
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
      await queue.stop();
      // Keep the webhook configured across graceful pod restarts.
    },
  };
}
