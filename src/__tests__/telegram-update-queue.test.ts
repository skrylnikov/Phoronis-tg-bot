import type { Bot } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';
import { Prisma } from '../generated/prisma/client';

const mocks = vi.hoisted(() => ({
  prisma: {
    telegramUpdate: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../db', () => ({ prisma: mocks.prisma }));
vi.mock('../logger', () => ({ logger: mocks.logger }));

import {
  classifyTelegramUpdate,
  createTelegramUpdateQueue,
  isTelegramUpdate,
  mapTelegramUpdateError,
} from '../telegram-update-queue';

const bot = {} as Bot<BotContext>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.telegramUpdate.create.mockResolvedValue({});
});

describe('Telegram update inbox routing', () => {
  it('keeps repository failures retryable', () => {
    const error = new Error('temporary database failure');
    expect(mapTelegramUpdateError(error)).toEqual({ kind: 'retryable', error });
  });

  it('validates update_id before enqueueing', () => {
    expect(isTelegramUpdate({ update_id: 1 })).toBe(true);
    expect(isTelegramUpdate({ update_id: -1 })).toBe(false);
    expect(isTelegramUpdate({ update_id: 1.5 })).toBe(false);
    expect(isTelegramUpdate({ update_id: '1' })).toBe(false);
  });

  it('serializes normal updates by chat and prioritizes callbacks', () => {
    expect(
      classifyTelegramUpdate({
        update_id: 1,
        message: {
          chat: { id: -100, type: 'supergroup' },
        },
      } as never),
    ).toEqual({ lane: 'NORMAL', partitionKey: 'chat:-100' });

    expect(
      classifyTelegramUpdate({
        update_id: 2,
        callback_query: {
          from: { id: 42, is_bot: false, first_name: 'User' },
        },
      } as never),
    ).toEqual({ lane: 'URGENT', partitionKey: 'user:42' });

    expect(
      classifyTelegramUpdate({
        update_id: 3,
        inline_query: {
          from: { id: 42, is_bot: false, first_name: 'User' },
        },
      } as never),
    ).toEqual({ lane: 'NORMAL', partitionKey: 'user:42' });

    expect(classifyTelegramUpdate({ update_id: 4 } as never)).toEqual({
      lane: 'NORMAL',
      partitionKey: 'global',
    });
  });

  it('persists a new update once and treats P2002 as a duplicate', async () => {
    const queue = createTelegramUpdateQueue(bot);
    const update = { update_id: 5 } as never;

    await expect(queue.enqueue(update)).resolves.toEqual({
      duplicate: false,
      lane: 'NORMAL',
      partitionKey: 'global',
    });

    mocks.prisma.telegramUpdate.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );

    await expect(queue.enqueue(update)).resolves.toEqual({
      duplicate: true,
      lane: 'NORMAL',
      partitionKey: 'global',
    });
    expect(mocks.prisma.telegramUpdate.create).toHaveBeenCalledTimes(2);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'update.duplicate', updateId: 5 }),
      expect.any(String),
    );
  });
});
