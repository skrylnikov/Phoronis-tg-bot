import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const { findFirst, findMany, error } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: {
    message: { findFirst, findMany },
  },
}));
vi.mock('../logger', () => ({ logger: { error } }));

import {
  canUseMissedMessagesTool,
  getMissedMessages,
} from '../ai/tools/missed-messages';

function createContext(type: 'private' | 'group' | 'supergroup' = 'group') {
  return {
    chat: { id: -100, type },
    chatId: -100,
    from: { id: 123 },
    msg: {
      message_id: 200,
      date: Math.floor(Date.UTC(2026, 6, 26, 10) / 1000),
    },
  } as unknown as BotContext;
}

function message(
  id: number,
  content: string,
  options: {
    summary?: string | null;
    type?: 'TEXT' | 'MEDIA' | 'VOICE';
    userName?: string | null;
    replyToMessageId?: number | null;
  } = {},
) {
  return {
    id: BigInt(id),
    replyToMessageId:
      options.replyToMessageId == null
        ? null
        : BigInt(options.replyToMessageId),
    messageType: options.type ?? 'TEXT',
    sentAt: new Date(Date.UTC(2026, 6, 26, 9, id % 60)),
    text: content,
    summary: options.summary ?? null,
    sender: {
      firstName: 'Имя',
      lastName: 'Фамилия',
      userName: options.userName ?? 'author',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
});

describe('getMissedMessages', () => {
  it('starts after the user’s last message today and returns chronological history', async () => {
    const lastUserMessage = {
      id: 100n,
      sentAt: new Date(Date.UTC(2026, 6, 26, 9)),
    };
    findFirst.mockResolvedValue(lastUserMessage);
    findMany.mockResolvedValue([
      message(102, 'Ответ бота', { userName: 'phoronis_bot' }),
      message(101, 'Новое сообщение', { replyToMessageId: 100 }),
    ]);

    const result = JSON.parse(await getMissedMessages(createContext(), {}));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          private: false,
          id: { lt: 200n, gt: 100n },
          sentAt: {
            gte: lastUserMessage.sentAt,
            lt: new Date(Date.UTC(2026, 6, 26, 10)),
          },
        }),
      }),
    );
    expect(result.messages.map((item: { id: string }) => item.id)).toEqual([
      '101',
      '102',
    ]);
    expect(result.messages[0]).toMatchObject({
      sender: '@author',
      replyToMessageId: '100',
    });
  });

  it('uses the beginning of the Moscow day when the user has not written today', async () => {
    findFirst.mockResolvedValue(null);

    await getMissedMessages(createContext(), {});

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sentAt: {
            gte: new Date(Date.UTC(2026, 6, 25, 21)),
            lt: new Date(Date.UTC(2026, 6, 26, 10)),
          },
        }),
      }),
    );
  });

  it('uses an explicit range instead of automatic activity detection', async () => {
    const startAt = '2026-07-24T10:00:00+03:00';
    const endAt = '2026-07-25T10:00:00+03:00';

    await getMissedMessages(createContext(), { startAt, endAt });

    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { lt: 200n },
          sentAt: {
            gte: new Date(startAt),
            lt: new Date(endAt),
          },
        }),
      }),
    );
  });

  it('excludes the current request, private messages, and empty content', async () => {
    findFirst.mockResolvedValue(null);
    findMany.mockResolvedValue([
      message(199, '  '),
      message(198, 'Есть текст'),
    ]);

    const result = JSON.parse(await getMissedMessages(createContext(), {}));

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe('198');
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      private: false,
      id: { lt: 200n },
    });
  });

  it('marks oversized history as truncated and retains the newest messages', async () => {
    findFirst.mockResolvedValue(null);
    findMany.mockResolvedValue(
      Array.from({ length: 501 }, (_, index) =>
        message(700 - index, `Сообщение ${index}`),
      ),
    );

    const result = JSON.parse(await getMissedMessages(createContext(), {}));

    expect(result.truncated).toBe(true);
    expect(result.notice).toContain('История усечена');
    expect(result.messages).not.toHaveLength(500);
    expect(Number(result.messages[0].id)).toBeGreaterThan(200);
    expect(result.messages.at(-1).id).toBe('700');
    expect(findMany.mock.calls[0][0].take).toBe(501);
  });

  it('returns a safe error for invalid intervals', async () => {
    const result = JSON.parse(
      await getMissedMessages(createContext(), {
        startAt: '2026-07-26T10:00:00+03:00',
        endAt: '2026-07-25T10:00:00+03:00',
      }),
    );

    expect(result).toEqual({
      error: 'Начало интервала должно быть раньше конца',
    });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('canUseMissedMessagesTool', () => {
  it('allows only ordinary group generation', () => {
    expect(canUseMissedMessagesTool(createContext('group'), false)).toBe(true);
    expect(canUseMissedMessagesTool(createContext('supergroup'), false)).toBe(
      true,
    );
    expect(canUseMissedMessagesTool(createContext('group'), true)).toBe(false);
    expect(canUseMissedMessagesTool(createContext('private'), false)).toBe(
      false,
    );
    expect(canUseMissedMessagesTool(undefined, false)).toBe(false);
  });
});
