import type { Bot } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';
import { runtimeState } from '../runtime-state';
import type { TelegramUpdateQueue } from '../telegram-update-queue';
import { createBotTransport } from '../transport';
import type { TransportConfig } from '../transport-config';

type MockBot = Bot<BotContext> & {
  api: Bot<BotContext>['api'] & { setWebhook: ReturnType<typeof vi.fn> };
  init: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

function createBot(): MockBot {
  return {
    api: {
      setWebhook: vi.fn(async () => true),
    },
    handleUpdate: vi.fn(async () => undefined),
    init: vi.fn(async () => undefined),
    isRunning: vi.fn(() => false),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as MockBot;
}

function createQueue() {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => ({
      duplicate: false,
      lane: 'NORMAL' as const,
      partitionKey: 'global',
    })),
  } satisfies TelegramUpdateQueue;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('bot transport', () => {
  it('starts polling without configuring a webhook', async () => {
    const bot = createBot();
    const pollingLoop = deferred<void>();
    bot.start.mockImplementation(() => pollingLoop.promise);
    const onPollingError = vi.fn();
    const transport = createBotTransport(
      bot,
      { mode: 'polling' },
      onPollingError,
    );

    runtimeState.setReady('database', true);
    runtimeState.setReady('embeddings', true);
    runtimeState.setReady('jobWorker', true);
    runtimeState.setReady('transport', false);
    runtimeState.setReady('updateWorkers', false);
    expect(runtimeState.isReady()).toBe(false);

    await transport.start();

    expect(bot.init).toHaveBeenCalledBefore(bot.start);
    expect(bot.start).toHaveBeenCalledOnce();
    expect(onPollingError).not.toHaveBeenCalled();
    expect(bot.api.setWebhook).not.toHaveBeenCalled();

    await transport.stop();
    pollingLoop.resolve();
    expect(onPollingError).not.toHaveBeenCalled();
  });

  it('keeps polling unready and fails startup when Telegram init fails', async () => {
    const bot = createBot();
    const error = new Error('Telegram init failed');
    bot.init.mockRejectedValueOnce(error);
    const onPollingError = vi.fn();
    const transport = createBotTransport(
      bot,
      { mode: 'polling' },
      onPollingError,
    );

    await expect(transport.start()).rejects.toThrow('Telegram init failed');
    expect(onPollingError).toHaveBeenCalledWith(error);
    expect(runtimeState.snapshot()).toMatchObject({
      transport: 'not-ready',
      updateWorkers: 'not-ready',
    });
  });

  it('resets readiness and reports a rejected polling loop', async () => {
    const bot = createBot();
    const pollingLoop = deferred<void>();
    bot.start.mockImplementation(() => pollingLoop.promise);
    const onPollingError = vi.fn();
    const transport = createBotTransport(
      bot,
      { mode: 'polling' },
      onPollingError,
    );

    await transport.start();
    expect(runtimeState.snapshot()).toMatchObject({
      transport: 'ready',
      updateWorkers: 'ready',
    });

    const error = new Error('polling stopped');
    pollingLoop.reject(error);
    await vi.waitFor(() => expect(onPollingError).toHaveBeenCalledWith(error));
    expect(runtimeState.snapshot()).toMatchObject({
      transport: 'not-ready',
      updateWorkers: 'not-ready',
    });
  });

  it('resets readiness when the polling loop ends unexpectedly', async () => {
    const bot = createBot();
    const pollingLoop = deferred<void>();
    bot.start.mockImplementation(() => pollingLoop.promise);
    const onPollingError = vi.fn();
    const transport = createBotTransport(
      bot,
      { mode: 'polling' },
      onPollingError,
    );

    await transport.start();
    pollingLoop.resolve();
    await vi.waitFor(() => expect(onPollingError).toHaveBeenCalledOnce());
    expect(onPollingError.mock.calls[0]?.[0]).toMatchObject({
      message: 'Polling loop ended unexpectedly',
    });
    expect(runtimeState.snapshot()).toMatchObject({
      transport: 'not-ready',
      updateWorkers: 'not-ready',
    });
  });

  it('configures webhook without starting polling', async () => {
    const bot = createBot();
    const queue = createQueue();
    const pollingStart = bot.start;
    const config: TransportConfig = {
      mode: 'webhook',
      webhookUrl: 'https://phoronis.example.test/telegram/webhook',
      webhookPath: '/telegram/webhook',
      webhookSecret: 'secret_123',
      webhookTimeoutMs: 50_000,
    };
    const transport = createBotTransport(bot, config, vi.fn(), queue);

    await transport.start();

    expect(bot.api.setWebhook).toHaveBeenCalledWith(config.webhookUrl, {
      drop_pending_updates: false,
      max_connections: 1,
      secret_token: config.webhookSecret,
    });
    expect(queue.start).toHaveBeenCalledOnce();
    expect(pollingStart).not.toHaveBeenCalled();
    expect(runtimeState.snapshot()).toMatchObject({
      transport: 'ready',
      updateWorkers: 'ready',
    });

    await transport.stop();
    expect(runtimeState.snapshot()).toMatchObject({
      transport: 'not-ready',
      updateWorkers: 'not-ready',
    });
  });

  it('rejects a webhook request with the wrong secret', async () => {
    const bot = createBot();
    const queue = createQueue();
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
      queue,
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

  it('rejects malformed webhook payloads with 400', async () => {
    const bot = createBot();
    const queue = createQueue();
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
      queue,
    );

    const response = await transport.webhookHandler?.({
      headers: new Headers({
        'X-Telegram-Bot-Api-Secret-Token': 'secret_123',
      }),
      json: async () => ({ message: { text: 'missing update id' } }),
    });

    expect(response?.status).toBe(400);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('returns 500 when the inbox database is unavailable', async () => {
    const bot = createBot();
    const queue = createQueue();
    queue.enqueue.mockRejectedValueOnce(new Error('database unavailable'));
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
      queue,
    );

    const response = await transport.webhookHandler?.({
      headers: new Headers({
        'X-Telegram-Bot-Api-Secret-Token': 'secret_123',
      }),
      json: async () => ({ update_id: 43 }),
    });

    expect(response?.status).toBe(500);
  });

  it('returns 200 for a duplicate without handling it inline', async () => {
    const bot = createBot();
    const queue = createQueue();
    queue.enqueue.mockResolvedValueOnce({
      duplicate: true,
      lane: 'NORMAL',
      partitionKey: 'global',
    });
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
      queue,
    );

    const response = await transport.webhookHandler?.({
      headers: new Headers({
        'X-Telegram-Bot-Api-Secret-Token': 'secret_123',
      }),
      json: async () => ({ update_id: 44 }),
    });

    expect(response?.status).toBe(200);
    expect(bot.handleUpdate).not.toHaveBeenCalled();
  });

  it('handles a valid webhook update', async () => {
    const bot = createBot();
    const queue = createQueue();
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
      queue,
    );
    const update = { update_id: 42 };

    const response = await transport.webhookHandler?.({
      headers: new Headers({
        'X-Telegram-Bot-Api-Secret-Token': 'secret_123',
      }),
      json: async () => update,
    });

    expect(response?.status).toBe(200);
    expect(queue.enqueue).toHaveBeenCalledWith(update);
    expect(bot.handleUpdate).not.toHaveBeenCalled();
  });
});
