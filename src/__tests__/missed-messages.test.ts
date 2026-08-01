import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const {
  messageCount,
  messageFindFirst,
  messageFindMany,
  chatFindUnique,
  userFindMany,
  embedQuery,
  searchChatMessages,
  error,
  warn,
} = vi.hoisted(() => ({
  messageCount: vi.fn(),
  messageFindFirst: vi.fn(),
  messageFindMany: vi.fn(),
  chatFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  embedQuery: vi.fn(),
  searchChatMessages: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: {
    message: {
      count: messageCount,
      findFirst: messageFindFirst,
      findMany: messageFindMany,
    },
    chat: { findUnique: chatFindUnique },
    user: { findMany: userFindMany },
  },
}));
vi.mock('../ai/embedding/client', () => ({ embedQuery }));
vi.mock('../ai/embedding/store', () => ({ searchChatMessages }));
vi.mock('../logger', () => ({ logger: { error, warn } }));

import {
  canUseChatHistoryTool,
  getRecentPublicChatContext,
  searchChatHistory,
} from '../ai/tools/chat-history';

function createContext(
  type: 'private' | 'group' | 'supergroup' = 'group',
): BotContext {
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
    senderId?: number;
    replyToMessageId?: number | null;
  } = {},
) {
  return {
    id: BigInt(id),
    replyToMessageId:
      options.replyToMessageId == null
        ? null
        : BigInt(options.replyToMessageId),
    senderId: BigInt(options.senderId ?? 456),
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
  chatFindUnique.mockResolvedValue({ privateModeEnabled: false });
  userFindMany.mockResolvedValue([]);
  messageFindMany.mockResolvedValue([]);
  messageCount.mockResolvedValue(0);
  searchChatMessages.mockResolvedValue([]);
});

describe('searchChatHistory', () => {
  it('preserves the missed-message range after the requester’s latest message', async () => {
    messageFindFirst.mockResolvedValue({
      id: 100n,
      sentAt: new Date(Date.UTC(2026, 6, 26, 9)),
    });
    messageFindMany.mockResolvedValue([
      message(102, 'Ответ бота', { userName: 'phoronis_bot' }),
      message(101, 'Новое сообщение', { replyToMessageId: 100 }),
    ]);

    const result = JSON.parse(await searchChatHistory(createContext(), {}));

    expect(result.messages.map((item: { id: string }) => item.id)).toEqual([
      '101',
      '102',
    ]);
    expect(result.messages[0]).toMatchObject({
      sender: '@author',
      replyToMessageId: '100',
    });
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          private: false,
          id: { gt: 100n, lt: 200n },
        }),
      }),
    );
  });

  it('gets latest messages without using the missed-message anchor', async () => {
    messageFindMany.mockResolvedValue([
      message(102, 'Позже'),
      message(101, 'Раньше'),
    ]);

    const result = JSON.parse(
      await searchChatHistory(createContext(), {
        recentMode: 'latest',
        limit: 2,
      }),
    );

    expect(messageFindFirst).not.toHaveBeenCalled();
    expect(result.messages.map((item: { id: string }) => item.id)).toEqual([
      '101',
      '102',
    ]);
  });

  it('merges exact and semantic search results without duplicates', async () => {
    messageCount.mockResolvedValue(1);
    messageFindMany.mockResolvedValue([message(101, 'Обсуждали релиз')]);
    embedQuery.mockResolvedValue([0.1, 0.2]);
    searchChatMessages.mockResolvedValue([
      message(101, 'Обсуждали релиз'),
      { ...message(102, 'Похожая тема'), similarity: 0.91 },
    ]);

    const result = JSON.parse(
      await searchChatHistory(createContext(), {
        mode: 'search',
        query: 'где обсуждали релиз новой версии',
        limit: 10,
      }),
    );

    expect(embedQuery).toHaveBeenCalledWith('где обсуждали релиз новой версии');
    expect(result.messages.map((item: { id: string }) => item.id)).toEqual([
      '101',
      '102',
    ]);
    expect(result.messages[1].similarity).toBe(0.91);
  });

  it('returns a user count and a bounded sample', async () => {
    userFindMany.mockResolvedValue([
      {
        id: 456n,
        firstName: 'Имя',
        lastName: 'Фамилия',
        userName: 'author',
      },
    ]);
    messageCount.mockResolvedValue(12);
    messageFindMany.mockResolvedValue([
      message(102, 'Второе', { senderId: 456 }),
      message(101, 'Первое', { senderId: 456 }),
    ]);

    const result = JSON.parse(
      await searchChatHistory(createContext(), {
        mode: 'user_stats',
        sender: '@author',
        limit: 2,
      }),
    );

    expect(result.totalCount).toBe(12);
    expect(result.truncated).toBe(true);
    expect(result.messages.map((item: { id: string }) => item.id)).toEqual([
      '101',
      '102',
    ]);
  });

  it('returns candidates for an ambiguous sender', async () => {
    userFindMany.mockResolvedValue([
      { id: 456n, firstName: 'Алексей', lastName: null, userName: null },
      { id: 789n, firstName: 'Александр', lastName: null, userName: null },
    ]);

    const result = JSON.parse(
      await searchChatHistory(createContext(), {
        mode: 'user_stats',
        sender: 'Алекс',
      }),
    );

    expect(result.candidates).toEqual([
      { id: '456', sender: 'Алексей' },
      { id: '789', sender: 'Александр' },
    ]);
    expect(messageCount).not.toHaveBeenCalled();
  });

  it('rejects history in private mode and filters current messages from auto context', async () => {
    chatFindUnique.mockResolvedValue({ privateModeEnabled: true });
    const privateResult = JSON.parse(
      await searchChatHistory(createContext(), { mode: 'recent' }),
    );
    expect(privateResult.error).toContain('приватном режиме');

    chatFindUnique.mockResolvedValue({ privateModeEnabled: false });
    messageFindMany.mockResolvedValue([
      message(199, 'Последнее'),
      message(198, 'Предыдущее'),
    ]);
    const context = await getRecentPublicChatContext(-100, 200);

    expect(context.messages.map((item) => item.id)).toEqual(['198', '199']);
    expect(messageFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          private: false,
          id: { lt: 200n },
        }),
      }),
    );
  });
});

describe('canUseChatHistoryTool', () => {
  it('allows only ordinary public group generation', () => {
    expect(canUseChatHistoryTool(createContext('group'), false)).toBe(true);
    expect(canUseChatHistoryTool(createContext('supergroup'), false)).toBe(
      true,
    );
    expect(canUseChatHistoryTool(createContext('group'), true)).toBe(false);
    expect(canUseChatHistoryTool(createContext('private'), false)).toBe(false);
    expect(canUseChatHistoryTool(undefined, false)).toBe(false);
  });
});
