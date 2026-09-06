import { expect, mock, test } from 'bun:test';
import type { BotContext } from '../bot';
import { prisma } from '../db';

let extracted: unknown = { facts: [], aliases: [] };
mock.module('ai', () => ({
  dynamicTool: (definition: unknown) => definition,
  generateObject: async () => ({ object: extracted }),
  generateText: async () => {
    throw new Error('Unexpected extra model call');
  },
  Output: { object: (schema: unknown) => schema },
}));
mock.module('../ai/ai', () => ({ utilityModel: { modelId: 'controlled' } }));
mock.module('../ai/embedding/client', () => ({
  embedQueryAndPassage: () => {
    throw new Error('Unexpected embedding call');
  },
  embedQuery: () => [],
}));
mock.module('../ai/embedding/store', () => ({
  searchSimilarFacts: () => [],
  updateFactEmbedding: () => {},
  searchChatMessages: () => [],
  searchChatMessagesLexical: () => [],
}));
mock.module('../domain/memory', () => ({ getUserPersonalMemories: () => [] }));

const { analyzeUserMetaInfo } = await import('../domain/user/fact-analyzer');
const { getAliasContext } = await import('../ai/alias-context');
const { createMyAliasTool } = await import('../ai/tools/my-alias');
const { createUserInfoTool } = await import('../ai/tools/user-info');
const { searchChatHistory } = await import('../ai/tools/chat-history');
const { resolveChatUser } = await import('../domain/user/resolve-chat-user');
const { findUserAliasesRepo } = await import(
  '../repositories/user-alias-repository'
);

test('controlled model → PostgreSQL → history/profile → addressing → prefer/avoid/reject', async () => {
  const userId = BigInt(Date.now());
  const otherId = userId + 1n;
  const chatId = -userId;
  const otherChatId = chatId - 1n;
  await prisma.user.createMany({
    data: [
      { id: userId, firstName: 'Александр' },
      { id: otherId, firstName: 'Иван' },
      { id: userId + 2n, firstName: 'Bot' },
    ],
  });
  await prisma.chat.createMany({
    data: [chatId, otherChatId].map((id) => ({
      id,
      title: 'Synthetic aliases',
      chatType: 'GROUP' as const,
    })),
  });
  const profile = { id: userId, firstName: 'Александр', userName: null };
  const ctx = (text: string, messageId = 100): BotContext =>
    ({
      chatId: Number(chatId),
      chat: { id: Number(chatId), type: 'supergroup' },
      from: { id: Number(userId), first_name: 'Александр' },
      msg: { message_id: messageId, date: Math.floor(Date.now() / 1000), text },
      api: { getChatMember: async () => ({ status: 'member' }) },
    }) as unknown as BotContext;
  const owner = async (
    text: string,
    alias: string,
    action: string,
    messageId: number,
  ) => {
    const tool = createMyAliasTool(ctx(text, messageId));
    if (!tool.execute) throw new Error('Missing tool');
    return JSON.parse(
      String(await tool.execute({ alias, action }, {} as never)),
    );
  };
  try {
    await prisma.message.create({
      data: {
        chatId,
        id: 1n,
        senderId: userId,
        text: 'Привет',
        messageType: 'TEXT',
        sentAt: new Date('2026-09-01'),
      },
    });
    for (let index = 0; index < 5; index++) {
      const senderId = index % 2 ? userId : otherId;
      const message = await prisma.message.create({
        data: {
          chatId,
          id: BigInt(index + 2),
          senderId,
          replyToMessageId: 1n,
          text: 'Шурик, привет',
          messageType: 'TEXT',
          sentAt: new Date(Date.UTC(2026, 8, index + 1)),
        },
        include: { replyToMessage: true },
      });
      extracted = {
        facts: [],
        aliases: [
          {
            userId: String(userId),
            alias: 'Шурик',
            confidence: 0.8,
            sourceMessageId: String(message.id),
            neutralForAddressing: true,
          },
        ],
      };
      await analyzeUserMetaInfo(senderId, [message], userId + 2n);
      await analyzeUserMetaInfo(senderId, [message], userId + 2n);
    }
    expect(
      (await findUserAliasesRepo(chatId, userId))[0]?.confidence,
    ).toBeCloseTo(0.91808, 10);
    expect(await resolveChatUser(chatId, 'Шурик')).toEqual({
      senderId: userId,
    });
    expect(await resolveChatUser(otherChatId, 'Шурик')).toMatchObject({
      candidates: [],
    });
    const history = JSON.parse(
      await searchChatHistory(ctx('История'), {
        mode: 'user_stats',
        sender: 'Шурик',
      }),
    );
    expect(history.totalCount).toBe(3);
    expect(
      history.messages.every(
        (message: { senderId: string }) => message.senderId === String(userId),
      ),
    ).toBe(true);
    const searched = JSON.parse(
      await searchChatHistory(ctx('Поиск'), {
        mode: 'search',
        sender: 'Шурик',
        query: 'привет',
      }),
    );
    expect(searched.exactCount).toBe(3);
    const tool = createUserInfoTool(ctx('Кто это?'));
    if (!tool.execute) throw new Error('Missing tool');
    expect(
      JSON.parse(String(await tool.execute({ query: 'Шурик' }, {} as never))),
    ).toMatchObject({
      user: { id: String(userId) },
      aliases: [{ alias: 'Шурик' }],
    });
    expect((await getAliasContext(chatId, profile)).addressing).toBe('Шурик');
    expect(
      await owner('называй меня Саша', 'Саша', 'prefer', 101),
    ).toMatchObject({ success: true, aliasContext: { addressing: 'Саша' } });
    expect(
      await owner('не называй меня Сашей', 'Саша', 'avoid_addressing', 102),
    ).toMatchObject({ success: true, aliasContext: { addressing: 'Шурик' } });
    expect(await resolveChatUser(chatId, 'Саша')).toEqual({ senderId: userId });
    expect(
      await owner('Шурик не мой псевдоним', 'Шурик', 'reject_identity', 103),
    ).toMatchObject({
      success: true,
      aliasContext: { addressing: 'Александр' },
    });
    expect(await resolveChatUser(chatId, 'Шурик')).toMatchObject({
      candidates: [],
    });
    expect((await getAliasContext(otherChatId, profile)).aliases).toEqual([]);
  } finally {
    await prisma.message.deleteMany({ where: { chatId } });
    await prisma.chat.deleteMany({
      where: { id: { in: [chatId, otherChatId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userId, otherId, userId + 2n] } },
    });
  }
});
