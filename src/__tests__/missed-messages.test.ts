import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const {
  messageCount,
  messageFindFirst,
  messageFindMany,
  messageQueryRaw,
  chatFindUnique,
  userFindMany,
  embedQuery,
  searchChatMessages,
  searchChatMessagesLexical,
  error,
  warn,
} = vi.hoisted(() => ({
  messageCount: vi.fn(),
  messageFindFirst: vi.fn(),
  messageFindMany: vi.fn(),
  messageQueryRaw: vi.fn(),
  chatFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  embedQuery: vi.fn(),
  searchChatMessages: vi.fn(),
  searchChatMessagesLexical: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../repositories/embedding-repository', async () => {
  const actual = await vi.importActual('../repositories/embedding-repository');
  return {
    ...actual,
    findChatHistoryReplyRootsRepo: async () => messageQueryRaw(),
    fetchChatHistoryReplyGraphRepo: async () => messageQueryRaw(),
  };
});

vi.mock('../db', () => ({
  prisma: {
    message: {
      count: messageCount,
      findFirst: messageFindFirst,
      findMany: messageFindMany,
      $queryRaw: messageQueryRaw,
    },
    $queryRaw: messageQueryRaw,
    chat: { findUnique: chatFindUnique },
    user: { findMany: userFindMany },
  },
}));
vi.mock('../ai/embedding/client', () => ({ embedQuery }));
vi.mock('../ai/embedding/store', () => ({
  searchChatMessages,
  searchChatMessagesLexical,
}));
vi.mock('../logger', () => ({ logger: { error, warn } }));

import {
  canUseChatHistoryTool,
  getRecentPublicChatContext,
  searchChatHistory,
} from '../ai/tools/chat-history';

function createContext(
  type: 'private' | 'group' | 'supergroup' = 'group',
  replyTo?: { id: number; text: string },
): BotContext {
  return {
    chat: { id: -100, type },
    chatId: -100,
    from: { id: 123 },
    msg: {
      message_id: 200,
      date: Math.floor(Date.UTC(2026, 6, 26, 10) / 1000),
      reply_to_message: replyTo
        ? { message_id: replyTo.id, text: replyTo.text }
        : undefined,
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
  messageQueryRaw.mockResolvedValue([]);
  searchChatMessagesLexical.mockResolvedValue([]);
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

  it('resolves a generic chat-search follow-up to the original question', async () => {
    const originalQuery = 'Расскажи, кто в чате выращивает помидоры?';
    messageFindFirst
      .mockResolvedValueOnce({
        replyToMessageId: 100n,
        text: 'Судя по чату, помидоры выращивает Дзиуин.',
        summary: null,
        searchText: null,
      })
      .mockResolvedValueOnce({
        text: originalQuery,
        summary: null,
        searchText: null,
      });

    const result = JSON.parse(
      await searchChatHistory(
        createContext('group', {
          id: 199,
          text: 'Судя по чату, помидоры выращивает Дзиуин.',
        }),
        { mode: 'search', query: 'поищи по чату' },
      ),
    );

    expect(result.searchQuery).toBe(originalQuery);
    expect(searchChatMessagesLexical).toHaveBeenCalledWith(
      expect.objectContaining({ query: originalQuery }),
    );
    expect(embedQuery).toHaveBeenCalledWith(originalQuery);
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
    searchChatMessagesLexical.mockResolvedValue([
      {
        ...message(101, 'Обсуждали релиз'),
        lexicalRank: 1,
        exactMatch: true,
      },
      {
        ...message(103, 'Другой релевантный тред'),
        lexicalRank: 2,
        exactMatch: false,
      },
    ]);
    searchChatMessages.mockResolvedValue([
      { ...message(101, 'Обсуждали релиз'), similarity: 0.89 },
      { ...message(102, 'Похожая тема'), similarity: 0.91 },
    ]);
    messageQueryRaw
      .mockResolvedValueOnce([
        { candidateId: 101n, rootMessageId: 100n, incomplete: false },
        { candidateId: 102n, rootMessageId: 100n, incomplete: false },
        { candidateId: 103n, rootMessageId: 103n, incomplete: false },
      ])
      .mockResolvedValueOnce([
        { ...message(100, 'Начало треда'), rootMessageId: 100n, depth: 0 },
        {
          ...message(101, 'Обсуждали релиз', { replyToMessageId: 100 }),
          rootMessageId: 100n,
          depth: 1,
        },
        {
          ...message(102, 'Похожая тема', { replyToMessageId: 100 }),
          rootMessageId: 100n,
          depth: 1,
        },
        {
          ...message(103, 'Другой релевантный тред'),
          rootMessageId: 103n,
          depth: 0,
        },
      ]);

    const result = JSON.parse(
      await searchChatHistory(createContext(), {
        mode: 'search',
        query: 'где обсуждали релиз новой версии',
        limit: 10,
      }),
    );

    expect(embedQuery).toHaveBeenCalledWith('где обсуждали релиз новой версии');
    expect(result.threads).toHaveLength(2);
    expect(result.threads[0]).toMatchObject({
      rootMessageId: '100',
      matchedMessageId: '101',
      branchCount: 2,
      incomplete: false,
      truncated: false,
    });
    expect(
      result.threads[0].messages.map((item: { id: string }) => item.id),
    ).toEqual(['100', '101', '102']);
    expect(result.threads[0].messages[1].similarity).toBe(0.89);
    expect(result.threads[1]).toMatchObject({
      rootMessageId: '103',
      matchedMessageId: '103',
    });
    expect(result.threadReferences).toEqual([
      {
        number: 1,
        rootMessageId: '100',
        matchedMessageId: '101',
      },
      {
        number: 2,
        rootMessageId: '103',
        matchedMessageId: '103',
      },
    ]);
  });

  it('marks a thread incomplete when its parent is unavailable', async () => {
    messageCount.mockResolvedValue(1);
    messageFindMany.mockResolvedValue([message(101, 'Найдено')]);
    searchChatMessagesLexical.mockResolvedValue([
      {
        ...message(101, 'Найдено'),
        lexicalRank: 1,
        exactMatch: true,
      },
    ]);
    messageQueryRaw
      .mockResolvedValueOnce([
        { candidateId: 101n, rootMessageId: 101n, incomplete: true },
      ])
      .mockResolvedValueOnce([
        {
          ...message(101, 'Найдено', { replyToMessageId: 99 }),
          rootMessageId: 101n,
          depth: 0,
        },
      ]);

    const result = JSON.parse(
      await searchChatHistory(createContext(), {
        mode: 'search',
        query: 'Найдено',
      }),
    );

    expect(messageQueryRaw).toHaveBeenCalledTimes(2);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({
      rootMessageId: '101',
      incomplete: true,
    });
  });

  it('limits search results to ten distinct threads', async () => {
    const candidates = Array.from({ length: 11 }, (_, index) =>
      message(index + 1, `Тема ${index + 1}`),
    );
    messageCount.mockResolvedValue(11);
    messageFindMany.mockResolvedValue(candidates);
    searchChatMessagesLexical.mockResolvedValue(
      candidates.map((row, index) => ({
        ...row,
        lexicalRank: index + 1,
        exactMatch: true,
      })),
    );
    messageQueryRaw
      .mockResolvedValueOnce(
        candidates.map((row) => ({
          candidateId: row.id,
          rootMessageId: row.id,
          incomplete: false,
        })),
      )
      .mockResolvedValueOnce(
        candidates.map((row) => ({
          ...row,
          rootMessageId: row.id,
          depth: 0,
        })),
      );

    const result = JSON.parse(
      await searchChatHistory(createContext(), {
        mode: 'search',
        query: 'тема',
        limit: 10,
      }),
    );

    expect(result.threads).toHaveLength(10);
    expect(result.threadReferences).toHaveLength(10);
    expect(result.truncated).toBe(true);
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

  it('allows history in a personal chat when private mode is disabled', async () => {
    chatFindUnique.mockResolvedValue({ privateModeEnabled: false });

    const result = JSON.parse(
      await searchChatHistory(createContext('private'), { mode: 'recent' }),
    );

    expect(result.mode).toBe('recent');
    expect(result.error).toBeUndefined();
  });
});

describe('canUseChatHistoryTool', () => {
  it('allows ordinary private and group chat generation', () => {
    expect(canUseChatHistoryTool(createContext('group'), false)).toBe(true);
    expect(canUseChatHistoryTool(createContext('supergroup'), false)).toBe(
      true,
    );
    expect(canUseChatHistoryTool(createContext('group'), true)).toBe(false);
    expect(canUseChatHistoryTool(createContext('private'), false)).toBe(true);
    expect(canUseChatHistoryTool(undefined, false)).toBe(false);
  });
});

describe('buildMessageLink', () => {
  it('builds public and private supergroup links but skips basic groups', async () => {
    const { buildMessageLink } = await import('../ai/tools/chat-history');
    const publicContext = {
      ...createContext('supergroup'),
      chat: { id: -100123, type: 'supergroup', username: 'public_group' },
    } as unknown as BotContext;
    const privateContext = {
      ...createContext('supergroup'),
      chatId: -100123,
      chat: { id: -100123, type: 'supergroup' },
    } as unknown as BotContext;
    const basicGroupContext = createContext('group');

    expect(buildMessageLink(publicContext, 42n)).toBe(
      'https://t.me/public_group/42',
    );
    expect(buildMessageLink(privateContext, 42n)).toBe('https://t.me/c/123/42');
    expect(buildMessageLink(basicGroupContext, 42n)).toBeUndefined();
  });
});
