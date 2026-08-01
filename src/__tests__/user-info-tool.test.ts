import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const { prisma, getAllUserFacts, getUserPersonalMemories } = vi.hoisted(() => ({
  prisma: {
    message: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  getAllUserFacts: vi.fn(),
  getUserPersonalMemories: vi.fn(),
}));

vi.mock('../db', () => ({ prisma }));
vi.mock('../tools/memory', () => ({ getUserPersonalMemories }));
vi.mock('../tools/user/fact-analyzer', () => ({ getAllUserFacts }));

import { createUserInfoTool } from '../ai/tools/user-info';

function createContext(): BotContext {
  return {
    chat: { id: -100, type: 'supergroup' },
    chatId: -100,
    from: { id: 123 },
  } as unknown as BotContext;
}

async function runTool(context: BotContext, input: unknown) {
  const execute = createUserInfoTool(context).execute;
  if (!execute) {
    throw new Error('Tool execute function is missing');
  }

  return execute(input, {} as never);
}

const user = {
  id: 123n,
  firstName: 'Иван',
  lastName: null,
  userName: 'ivan',
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue(user);
  prisma.message.findFirst.mockResolvedValue({ id: 1n });
  getAllUserFacts.mockResolvedValue([
    {
      content: 'Любит чай',
      type: 'INTEREST',
      weight: 2,
      confidence: 0.9,
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      expiresAt: null,
    },
  ]);
  getUserPersonalMemories.mockResolvedValue([
    {
      content: 'Предпочитает короткие ответы',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
  ]);
});

describe('get_user_info tool', () => {
  it('returns all information for the current user', async () => {
    const result = await runTool(createContext(), {});

    expect(JSON.parse(String(result))).toMatchObject({
      user: { id: '123', userName: 'ivan' },
      facts: [{ content: 'Любит чай', type: 'INTEREST' }],
      personalMemories: [{ content: 'Предпочитает короткие ответы' }],
      memoryScope: 'all_chats',
    });
    expect(getUserPersonalMemories).toHaveBeenCalledWith(123n, {
      allChats: true,
    });
  });

  it('limits another participant memory to the current chat', async () => {
    const context = createContext();
    const result = await runTool(context, { userId: '456' });

    expect(JSON.parse(String(result)).memoryScope).toBe('current_chat');
    expect(getUserPersonalMemories).toHaveBeenCalledWith(456n, {
      chatId: -100n,
    });
    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: { chatId: -100n, senderId: 456n, private: false },
      select: { id: true },
    });
  });

  it('rejects a user outside the current chat', async () => {
    prisma.message.findFirst.mockResolvedValue(null);

    const result = await runTool(createContext(), { userId: '456' });

    expect(result).toBe(
      JSON.stringify({
        error: 'Пользователь не является участником текущего чата',
      }),
    );
    expect(getAllUserFacts).not.toHaveBeenCalled();
  });
});
