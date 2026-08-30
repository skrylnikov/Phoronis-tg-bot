import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const {
  prisma,
  getAllUserFacts,
  getChatMember,
  getUserPersonalMemories,
  loggerError,
} = vi.hoisted(() => ({
  prisma: { user: { findUnique: vi.fn() } },
  getAllUserFacts: vi.fn(),
  getChatMember: vi.fn(),
  getUserPersonalMemories: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../db', () => ({ prisma }));
vi.mock('../domain/memory', () => ({ getUserPersonalMemories }));
vi.mock('../domain/user/fact-analyzer', () => ({ getAllUserFacts }));
vi.mock('../logger', () => ({ logger: { error: loggerError } }));

import { createUserInfoTool } from '../ai/tools/user-info';

function createContext(): BotContext {
  return {
    chat: { id: -100, type: 'supergroup' },
    chatId: -100,
    from: { id: 123 },
    api: { getChatMember },
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
  getChatMember.mockResolvedValue({ status: 'member' });
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

  it('returns only current-chat facts for another current member', async () => {
    const context = createContext();
    const result = await runTool(context, { userId: '456' });

    expect(JSON.parse(String(result))).toMatchObject({
      memoryScope: 'none',
      personalMemories: [],
    });
    expect(getChatMember).toHaveBeenCalledWith(-100, 456);
    expect(getAllUserFacts).toHaveBeenCalledWith(456n, {
      sourceChatId: -100n,
    });
    expect(getUserPersonalMemories).not.toHaveBeenCalled();
  });

  it('rejects a user who left the current chat', async () => {
    getChatMember.mockResolvedValue({ status: 'left' });

    const result = await runTool(createContext(), { userId: '456' });

    expect(result).toBe(
      JSON.stringify({
        error: 'Пользователь не является участником текущего чата',
      }),
    );
    expect(getAllUserFacts).not.toHaveBeenCalled();
  });

  it('fails closed when Telegram membership cannot be checked', async () => {
    const error = new Error('Telegram unavailable');
    getChatMember.mockRejectedValue(error);

    const result = await runTool(createContext(), { userId: '456' });

    expect(result).toBe(
      JSON.stringify({
        error: 'Не удалось получить информацию о пользователе',
      }),
    );
    expect(getAllUserFacts).not.toHaveBeenCalled();
    expect(getUserPersonalMemories).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      { event: 'user_info.access_failed', err: error },
      'Failed to authorize or load user information',
    );
  });
});
